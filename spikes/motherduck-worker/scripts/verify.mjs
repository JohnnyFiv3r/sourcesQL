import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const base = process.env.PROBE_URL;
const token = process.env.GATEWAY_TOKEN;
const kind = process.env.PROBE_KIND ?? "tiny";
assert.ok(["tiny", "dependencies"].includes(kind));
if (!base || !token || process.env.ALLOW_LIVE_PROBE !== "true") {
  throw new Error("Set PROBE_URL, GATEWAY_TOKEN and ALLOW_LIVE_PROBE=true after confirming available free allowances.");
}
const url = new URL(base);
if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
  throw new Error("Use HTTPS or a loopback development Worker.");
}
const receipt = { evidence: "incomplete", request_id: randomUUID(), operations: [],
  kind,
  created_at: new Date().toISOString(), automatic_submit_retries: 0,
  flight_submission_attempts: 0, billed_flight_seconds: null, research_capacity_measured: false };
const artifacts = new URL("../../../artifacts/motherduck-probe/", import.meta.url);
let phase = "connection";
function save() {
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(new URL(`${receipt.request_id}.json`, artifacts), JSON.stringify(receipt, null, 2));
}
async function call(path, body) {
  if (path.startsWith("/flight/") && kind === "dependencies") {
    const parsed = new URL(path, base);
    parsed.searchParams.set("kind", kind);
    path = parsed.pathname + parsed.search;
  }
  const started = performance.now();
  const res = await fetch(new URL(path, base), { method: body ? "POST" : "GET", redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? {"x-vercel-protection-bypass":process.env.VERCEL_AUTOMATION_BYPASS_SECRET} : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  const data = await res.json();
  receipt.operations.push({ path: path.split("?")[0], status: res.status,
    error: data.error ?? null, database_code: data.database_code ?? null,
    elapsed_ms: Math.round(performance.now() - started) });
  if (body?.simulate_lost_response === true) {
    assert.equal(res.status, 502);
    assert.equal(data.error, "dispatch_outcome_unknown");
    assert.equal(data.automatic_retry, false);
  } else {
    assert.equal(res.status, 200, `${phase}: ${data.error ?? "unexpected response"}. Do not retry submission automatically.`);
  }
  return data;
}
try {
  assert.equal((await call("/connection")).rows[0].ok, 1);
  phase = "flight_submission";
  receipt.flight_submission_attempts = 1;
  save();
  // A durable local intent is written before the only dispatch attempt. Reusing
  // this receipt for recovery never invokes this verifier a second time.
  const beforeDispatch = (await call("/flight/runs")).runs.map(r => r.run_id);
  let submitted;
  if (kind === "tiny") {
    await call("/flight/submit", { request_id:receipt.request_id, kind, simulate_lost_response:true });
    phase = "lost_response_recovery";
    const recovered = await call(`/flight/recover?request_id=${receipt.request_id}`);
    assert.equal(recovered.recovery, "found");
    assert.equal(recovered.safe_to_resubmit, false);
    assert.equal(recovered.runs.length, 1);
    submitted = {run:recovered.runs[0]};
    receipt.lost_response_recovered_without_resubmit = true;
    receipt.loss_simulation = "gateway_failure_after_acknowledged_dispatch";
  } else {
    submitted = await call("/flight/submit", { request_id:receipt.request_id, kind });
  }
  receipt.run = submitted.run;
  assert.equal(submitted.run.config.REQUEST_ID, receipt.request_id);
  phase = "exact_run_status";
  const deadline = Date.now() + 180000;
  let run = submitted.run;
  while (["PENDING", "RUNNING"].includes(run.status.replace(/^RUN_STATUS_/, "")) && Date.now() < deadline) {
    save();
    await setTimeout(5000);
    const status = await call(`/flight/run?run_number=${run.run_number}`);
    assert.equal(status.runs.length, 1);
    run = status.runs[0];
    assert.equal(run.run_id, submitted.run.run_id);
    assert.equal(run.config.REQUEST_ID, receipt.request_id);
    receipt.run = run;
  }
  assert.equal(run.status.replace(/^RUN_STATUS_/, ""), "SUCCEEDED");
  assert.equal(run.exit_code, 0);
  const observedSeconds = run.started_at && run.ended_at
    ? (Date.parse(run.ended_at) - Date.parse(run.started_at)) / 1000 : null;
  receipt.observed_run_wall_seconds = Number.isFinite(observedSeconds) ? observedSeconds : null;
  phase = "flight_logs";
  const logs = await call(`/flight/logs?run_number=${run.run_number}`);
  receipt.log_columns = logs.rows.length ? Object.keys(logs.rows[0]) : [];
  const logLines = logs.rows.flatMap((row) => (row.line ?? row.logs ?? "").split(/\r?\n/));
  const completionFound = logLines.some((line) => {
    try {
      const completion = JSON.parse(line);
      const matched = completion.rows === 2 && completion.request_id === receipt.request_id;
      if (kind === "dependencies" && matched) receipt.compatibility = completion.compatibility;
      return matched && (completion.fixture === true || completion.compatibility?.fixture === true);
    } catch { return false; }
  });
  assert.ok(completionFound, "Exact-run logs must contain the correlated fixture completion marker.");
  receipt.correlated_completion_log_found = true;
  phase = "stored_results";
  const resultPath = `/results?request_id=${receipt.request_id}`;
  const first = await call(resultPath);
  assert.equal(first.rows.length, 2);
  assert.equal(first.columns.find((c) => c.name === "planned_mw").label, "Planned Capacity (MW)");
  assert.equal(first.rows[0].values.planned_mw, 500);
  assert.equal(first.rows[1].values.planned_mw, null);
  assert.equal(first.rows[0].values.evidence[0].source_id, "synthetic-source-a");
  if (kind === "dependencies") {
    receipt.compatibility = first.rows[0].values.compatibility;
    assert.equal(receipt.compatibility.packages_ok, true);
    assert.equal(receipt.compatibility.python.platform, "linux");
    assert.equal(receipt.compatibility.sql.status, "passed");
    assert.equal(receipt.compatibility.persisted, true);
    assert.equal(receipt.compatibility.provider_calls, 0);
    assert.equal(receipt.compatibility.engine.status, "not_tested");
  }
  const before = (await call("/flight/runs")).runs.map((r) => r.run_id);
  phase = "durable_correction_and_reopen";
  const revision = randomUUID();
  await call("/corrections", { request_id: receipt.request_id, revision_id: revision, row_id: "fictional-a", value: 480 });
  const reopened = await call(resultPath);
  assert.equal(reopened.rows[0].values.planned_mw, 500);
  assert.equal(reopened.corrections.find((c) => c.revision_id === revision).value, 480);
  assert.equal(reopened.rows.filter((r) => r.values.planned_mw >= 490).length, 1);
  assert.ok((await call("/tree")).nodes.some((n) => n.request_id === receipt.request_id));
  assert.deepEqual((await call("/flight/runs")).runs.map((r) => r.run_id), before);
  assert.equal(before.filter(id => !beforeDispatch.includes(id)).length, 1);
  receipt.evidence = kind === "dependencies" && !receipt.compatibility.python.matches
    ? "live_gateway_dependency_pass_runtime_mismatch" : "live_gateway_fixture_pass";
  receipt.flight_submissions = 1;
  receipt.gateway_url = url.origin;
  save();
  console.log(JSON.stringify({ evidence: receipt.evidence, request_id: receipt.request_id,
    observed_run_wall_seconds: receipt.observed_run_wall_seconds, billed_flight_seconds: null }));
} catch {
  receipt.failed_phase = phase;
  save();
  console.error(`Probe incomplete at ${phase}; inspect its local receipt. Submission is never retried. Inspect run history before further dispatch.`);
  process.exitCode = 1;
}
