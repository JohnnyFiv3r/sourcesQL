import assert from "node:assert/strict";
import { test } from "node:test";
import { makeGateway } from "../src/gateway.mjs";

const flightId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
const revisionId = "00000000-0000-4000-8000-000000000004";
const env = { GATEWAY_TOKEN: "test-gateway", MOTHERDUCK_TOKEN: "test-db-secret",
  MOTHERDUCK_DB: "probe", MOTHERDUCK_HOST: "pg.us-east-1-aws.motherduck.com",
  FLIGHT_ID: flightId, ALLOW_FLIGHT_SUBMISSION: "true" };
const run = { run_id: runId, flight_id: flightId, run_number: "9007199254740993",
  config_json: JSON.stringify({ REQUEST_ID: requestId }), status: "RUN_STATUS_RUNNING" };

function harness(query = async () => ({ rows: [] }), definitions = {}) {
  const calls = [];
  const client = { connect: async () => calls.push("connect"), end: async () => calls.push("end"),
    query: async (sql, values) => { calls.push({ sql, values }); return query(sql, values); } };
  const gateway = makeGateway(() => { calls.push("create"); return client; }, definitions);
  async function fetch(path, body, config = env, auth = true) {
    return gateway.fetch(new Request(`https://probe.invalid${path}`, { method: body ? "POST" : "GET",
      headers: auth ? { authorization: `Bearer ${config.GATEWAY_TOKEN}`, "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined }), config);
  }
  return { calls, fetch, client };
}

test("authentication, disabled submission and invalid IDs refuse before database connection", async () => {
  const h = harness();
  assert.equal((await h.fetch("/connection", undefined, env, false)).status, 401);
  assert.equal((await h.fetch("/flight/submit", { request_id: requestId }, { ...env, ALLOW_FLIGHT_SUBMISSION: "false" })).status, 403);
  assert.equal((await h.fetch("/flight/submit", { request_id: "x'); DROP TABLE secret;--" })).status, 400);
  assert.equal((await h.fetch("/flight/run?run_number=18446744073709551616")).status, 400);
  assert.equal((await h.fetch("/flight/run?run_number=1;SELECT%201")).status, 400);
  assert.deepEqual(h.calls, []);
});

test("only configured MotherDuck regional endpoints are accepted", async () => {
  const h = harness();
  assert.equal((await h.fetch("/connection", undefined, { ...env, MOTHERDUCK_HOST: "attacker.invalid" })).status, 503);
  assert.deepEqual(h.calls, []);
});

test("provisioning requires authentication and a separate explicit enablement", async () => {
  const h = harness();
  const enabled = { ...env, ALLOW_FLIGHT_PROVISIONING: "true" };
  assert.equal((await h.fetch("/flight/create", { kind: "tiny" }, enabled, false)).status, 401);
  const disabled = await h.fetch("/flight/create", { kind: "tiny" });
  assert.equal(disabled.status, 403);
  assert.deepEqual(await disabled.json(), { error: "provisioning_disabled" });
  assert.deepEqual(h.calls, []);
});

test("unknown Flight definitions and invalid database names refuse before connecting", async () => {
  const h = harness(async () => ({ rows: [] }), {
    tiny: { name: "fixed_probe", source: "print('fixture')", requirements: "duckdb==1.5.6" },
  });
  const enabled = { ...env, ALLOW_FLIGHT_PROVISIONING: "true" };
  assert.equal((await h.fetch("/flight/create", { kind: "unknown" }, enabled)).status, 400);
  assert.equal((await h.fetch("/flight/create", {}, enabled)).status, 400);
  assert.equal((await h.fetch("/flight/create", { kind: "tiny" }, {
    ...enabled, MOTHERDUCK_DB: "probe'); SELECT 1;--",
  })).status, 400);
  assert.deepEqual(h.calls, []);
});

test("creation uses the fixed definition and seeds correlation without running or scheduling", async () => {
  const definition = { name: "owner's_probe", source: "print('fixed fixture')\n", requirements: "duckdb==1.5.6" };
  const created = { flight_id: flightId, flight_name: definition.name, current_version: 1 };
  const h = harness(async () => ({ rows: [created] }), { tiny: definition });
  const res = await h.fetch("/flight/create", {
    kind: "tiny",
    name: "request_owned_name",
    source_code: "request_owned_source",
    requirements_txt: "request_owned_package",
    config: { REQUEST_ID: requestId, DATABASE: "request_owned_database" },
    instance_type: "F32",
    max_runtime_sec: 999999,
    schedule_cron: "* * * * *",
  }, { ...env, ALLOW_FLIGHT_PROVISIONING: "true", ALLOW_FLIGHT_SUBMISSION: "false" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    flights: [created], kind: "tiny", instance_type: "F4", max_runtime_sec: 120, scheduled: false,
  });
  const queries = h.calls.filter((c) => c.sql);
  assert.equal(queries.length, 1);
  const { sql, values } = queries[0];
  assert.match(sql, /md_create_flight\(/);
  assert.ok(sql.includes("name := 'owner''s_probe'"));
  assert.ok(sql.includes("source_code := 'print(''fixed fixture'')\n'"));
  assert.ok(sql.includes("requirements_txt := 'duckdb==1.5.6'"));
  assert.match(sql, /config := MAP \{'REQUEST_ID': 'unsubmitted', 'DATABASE': 'probe'\}/);
  assert.match(sql, /instance_type := 'F4', max_runtime_sec := 120/);
  assert.doesNotMatch(sql, /request_owned|schedule_cron|md_run_flight\(|test-db-secret/);
  assert.equal(values, undefined);
  assert.equal(h.calls.at(-1), "end");
});

test("failed provisioning is not retried and does not expose database error detail", async () => {
  const h = harness(async () => { throw new Error("test-db-secret postgresql://secret"); }, {
    tiny: { name: "fixed_probe", source: "print('fixture')", requirements: "duckdb==1.5.6" },
  });
  const res = await h.fetch("/flight/create", { kind: "tiny" }, { ...env, ALLOW_FLIGHT_PROVISIONING: "true" });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "gateway_operation_failed", automatic_retry: false });
  assert.equal(h.calls.filter((c) => c.sql).length, 1);
  assert.equal(h.calls.at(-1), "end");
});

test("submit uses correlated literal config and retains unsigned run number as a string", async () => {
  const h = harness(async () => ({ rows: [run] }));
  const res = await h.fetch("/flight/submit", { request_id: requestId });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.run.run_number, "9007199254740993");
  assert.equal(data.run.config.REQUEST_ID, requestId);
  const sql = h.calls.find((c) => c.sql).sql;
  assert.match(sql, /md_run_flight/);
  assert.ok(sql.includes(requestId));
  assert.equal(h.calls.filter((c) => c.sql).length, 1);
  assert.equal(h.calls.at(-1), "end");
});

test("ambiguous submission is not retried and database error text is hidden", async () => {
  const h = harness(async () => { throw new Error("test-db-secret postgresql://secret"); });
  const res = await h.fetch("/flight/submit", { request_id: requestId });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "dispatch_outcome_unknown", automatic_retry: false });
  assert.equal(h.calls.filter((c) => c.sql).length, 1);
  assert.equal(h.calls.at(-1), "end");
});

test("a lost successful submit response is recovered without repeating dispatch", async () => {
  const savedRuns = [];
  const h = harness(async (sql) => {
    if (sql.includes("md_run_flight(")) {
      savedRuns.push(run);
      return { rows: [run] };
    }
    assert.match(sql, /md_list_flight_runs\(/);
    return { rows: savedRuns };
  });
  const submitted = await h.fetch("/flight/submit", {
    request_id: requestId, simulate_lost_response: true,
  });
  assert.equal(submitted.status, 502);
  assert.deepEqual(await submitted.json(), { error: "dispatch_outcome_unknown", automatic_retry: false });
  assert.equal(savedRuns.length, 1);
  const recovered = await h.fetch(`/flight/recover?request_id=${requestId}`);
  assert.equal(recovered.status, 200);
  const data = await recovered.json();
  assert.equal(data.recovery, "found");
  assert.equal(data.safe_to_resubmit, false);
  assert.equal(data.runs[0].run_id, runId);
  assert.equal(data.runs[0].config.REQUEST_ID, requestId);
  const queries = h.calls.filter((c) => c.sql);
  assert.equal(queries.length, 2);
  assert.equal(queries.filter((c) => c.sql.includes("md_run_flight(")).length, 1);
  assert.equal(queries.filter((c) => c.sql.includes("md_list_flight_runs(")).length, 1);
  assert.equal(h.calls.filter((c) => c === "end").length, 2);
});

test("dependency submission and inspection use only the separately configured Flight", async () => {
  const dependencyFlight = "00000000-0000-4000-8000-000000000005";
  const dependencyRun = { ...run, flight_id: dependencyFlight };
  const h = harness(async (sql) => ({ rows: sql.includes("md_get_flight_logs(") ? [] : [dependencyRun] }));
  const configured = { ...env, DEPENDENCY_FLIGHT_ID: dependencyFlight };
  const submitted = await h.fetch("/flight/submit", { request_id: requestId, kind: "dependencies" }, configured);
  assert.equal(submitted.status, 200);
  assert.equal((await submitted.json()).run.flight_id, dependencyFlight);
  for (const path of [
    `/flight/run?run_number=${run.run_number}&kind=dependencies`,
    "/flight/runs?kind=dependencies",
    `/flight/logs?run_number=${run.run_number}&kind=dependencies`,
    `/flight/recover?request_id=${requestId}&kind=dependencies`,
  ]) {
    const res = await h.fetch(path, undefined, configured);
    assert.equal(res.status, 200);
    if (path.startsWith("/flight/recover")) {
      const data = await res.json();
      assert.equal(data.recovery, "found");
      assert.equal(data.runs[0].flight_id, dependencyFlight);
      assert.equal(data.safe_to_resubmit, false);
    }
  }
  const queries = h.calls.filter((c) => c.sql);
  assert.equal(queries.length, 5);
  assert.ok(queries.every((c) => c.sql.includes(`flight_id := '${dependencyFlight}'::UUID`)));
  assert.ok(queries.every((c) => !c.sql.includes(`flight_id := '${flightId}'::UUID`)));
  assert.equal(queries.filter((c) => c.sql.includes("md_run_flight(")).length, 1);
});

test("unknown Flight kinds and unconfigured dependencies cannot dispatch or inspect", async () => {
  const h = harness();
  for (const kind of ["unknown", "dependencies"]) {
    assert.equal((await h.fetch("/flight/submit", { request_id: requestId, kind })).status, 400);
    for (const path of [
      `/flight/run?run_number=1&kind=${kind}`,
      `/flight/runs?kind=${kind}`,
      `/flight/logs?run_number=1&kind=${kind}`,
      `/flight/recover?request_id=${requestId}&kind=${kind}`,
    ]) {
      assert.equal((await h.fetch(path)).status, 400);
    }
  }
  assert.deepEqual(h.calls, []);
});

test("provider UUIDs are not restricted to legacy UUID versions", async () => {
  const providerFlight = "00000000-0000-7000-8000-000000000001";
  const providerRun = "00000000-0000-7000-8000-000000000003";
  const h = harness(async () => ({ rows: [{ ...run, flight_id: providerFlight, run_id: providerRun }] }));
  const res = await h.fetch("/flight/submit", { request_id: requestId }, { ...env, FLIGHT_ID: providerFlight });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).run.run_id, providerRun);
});

test("an uncorrelated run response is an unknown dispatch outcome", async () => {
  const h = harness(async () => ({ rows: [{ ...run, config_json: '{}' }] }));
  assert.equal((await (await h.fetch("/flight/submit", { request_id: requestId })).json()).error, "dispatch_outcome_unknown");
});

test("status, history and logs use current exact-run interfaces without submission", async () => {
  const h = harness(async (sql) => ({ rows: sql.includes("logs") ? [] : [run] }));
  for (const path of ["/flight/run?run_number=9007199254740993", "/flight/runs", "/flight/logs?run_number=9007199254740993"]) {
    assert.equal((await h.fetch(path)).status, 200);
  }
  const sqls = h.calls.filter((c) => c.sql).map((c) => c.sql).join("\n");
  assert.match(sqls, /md_get_flight_run/);
  assert.match(sqls, /md_list_flight_runs/);
  assert.match(sqls, /md_get_flight_logs/);
  assert.doesNotMatch(sqls, /md_run_flight\(/);
  assert.ok(sqls.includes("9007199254740993::UBIGINT"));
});

test("recovery rejects missing or malformed request IDs before connecting", async () => {
  const h = harness();
  for (const path of ["/flight/recover", "/flight/recover?request_id=not-a-uuid", "/flight/recover?request_id=1%27%3BSELECT%201"]) {
    const res = await h.fetch(path);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_input" });
  }
  assert.deepEqual(h.calls, []);
});

test("recovery selects only the matching stored request config without dispatching", async () => {
  const unrelated = { ...run, run_id: revisionId, config_json: JSON.stringify({ REQUEST_ID: revisionId }) };
  const missingConfig = { ...run, config_json: '{}' };
  const h = harness(async () => ({ rows: [unrelated, run, missingConfig] }));
  const res = await h.fetch(`/flight/recover?request_id=${requestId}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.request_id, requestId);
  assert.equal(data.recovery, "found");
  assert.equal(data.safe_to_resubmit, false);
  assert.equal(data.runs.length, 1);
  assert.equal(data.runs[0].run_id, runId);
  assert.equal(data.runs[0].run_number, "9007199254740993");
  assert.deepEqual(data.runs[0].config, { REQUEST_ID: requestId });
  const queries = h.calls.filter((c) => c.sql);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /md_list_flight_runs\(/);
  assert.ok(queries[0].sql.includes(`flight_id := '${flightId}'::UUID, "LIMIT" := 20`));
  assert.doesNotMatch(queries[0].sql, /md_run_flight\(|md_create_flight\(/);
  assert.equal(h.calls.at(-1), "end");
});

test("absence from the bounded latest history never authorizes a resubmission", async () => {
  const unrelatedRuns = Array.from({ length: 20 }, (_, index) => ({
    ...run, run_number: String(index + 1), config_json: JSON.stringify({ REQUEST_ID: revisionId }),
  }));
  const h = harness(async () => ({ rows: unrelatedRuns }));
  const res = await h.fetch(`/flight/recover?request_id=${requestId}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    request_id: requestId, runs: [], recovery: "not_found_in_latest_20", safe_to_resubmit: false,
  });
  const queries = h.calls.filter((c) => c.sql);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0].sql, /md_run_flight\(|md_create_flight\(/);
  assert.equal(h.calls.at(-1), "end");
});

test("duplicate correlated runs are retained as ambiguous and never resubmitted", async () => {
  const second = { ...run, run_id: revisionId, run_number: "9007199254740994" };
  const h = harness(async () => ({ rows: [run, second] }));
  const res = await h.fetch(`/flight/recover?request_id=${requestId}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.recovery, "duplicate_runs");
  assert.equal(data.safe_to_resubmit, false);
  assert.deepEqual(data.runs.map((r) => r.run_id), [runId, revisionId]);
  assert.ok(data.runs.every((r) => r.config.REQUEST_ID === requestId));
  const queries = h.calls.filter((c) => c.sql);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0].sql, /md_run_flight\(|md_create_flight\(/);
  assert.equal(h.calls.at(-1), "end");
});

test("failed history inspection cannot trigger a recovery submission or expose secrets", async () => {
  const h = harness(async () => { throw new Error("test-db-secret postgresql://secret"); });
  const res = await h.fetch(`/flight/recover?request_id=${requestId}`);
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "gateway_operation_failed", automatic_retry: false });
  const queries = h.calls.filter((c) => c.sql);
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0].sql, /md_run_flight\(|md_create_flight\(/);
  assert.equal(h.calls.at(-1), "end");
});

test("stored result reopen preserves numbers, nulls, nested evidence and friendly metadata", async () => {
  const h = harness(async (sql, values) => {
    assert.deepEqual(values, [requestId]);
    if (sql.includes("probe_jobs")) return { rows: [{ columns_json: '[{"name":"planned_mw","label":"Planned Capacity (MW)"}]' }] };
    if (sql.includes("probe_rows")) return { rows: [{ row_id: "fictional-a", payload_json: '{"planned_mw":500,"unknown":null,"evidence":[{"source_id":"s1"}]}' }] };
    return { rows: [{ revision_id: revisionId, value: 480 }] };
  });
  const data = await (await h.fetch(`/results?request_id=${requestId}`)).json();
  assert.equal(data.columns[0].label, "Planned Capacity (MW)");
  assert.equal(data.rows[0].values.planned_mw, 500);
  assert.equal(data.rows[0].values.unknown, null);
  assert.equal(data.rows[0].values.evidence[0].source_id, "s1");
  assert.equal(data.corrections[0].value, 480);
  assert.ok(h.calls.filter((c) => c.sql).every((c) => !c.sql.includes("md_run_flight")));
});

test("pending result reads and tree reads do not trigger a Flight", async () => {
  const h = harness();
  assert.equal((await (await h.fetch(`/results?request_id=${requestId}`)).json()).pending, true);
  assert.equal((await h.fetch("/tree")).status, 200);
  assert.ok(h.calls.filter((c) => c.sql).every((c) => !c.sql.includes("md_run_flight")));
});

test("corrections append bound historical records without updating original rows", async () => {
  const h = harness(async () => ({ rows: [{ revision_id: revisionId }] }));
  const data = await (await h.fetch("/corrections", { request_id: requestId, revision_id: revisionId, row_id: "fictional-a", value: 480 })).json();
  assert.equal(data.revision_id, revisionId);
  const call = h.calls.find((c) => c.sql);
  assert.match(call.sql, /INSERT INTO sourcesql_gateway_probe_corrections/);
  assert.doesNotMatch(call.sql, /UPDATE|md_run_flight/);
  assert.deepEqual(call.values, [revisionId, requestId, "fictional-a", 480]);
});

test("missing correction target is never reported as accepted", async () => {
  const h = harness();
  const data = await (await h.fetch("/corrections", { request_id: requestId, revision_id: revisionId, row_id: "fictional-a", value: 480 })).json();
  assert.equal(data.accepted, false);
});

test("failed connect is closed without submitting or exposing credentials", async () => {
  const h = harness();
  h.client.connect = async () => { throw new Error("test-db-secret"); };
  const res = await h.fetch("/flight/submit", { request_id: requestId });
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "gateway_operation_failed", automatic_retry: false });
  assert.equal(h.calls.at(-1), "end");
  assert.equal(h.calls.filter((c) => c.sql).length, 0);
});
