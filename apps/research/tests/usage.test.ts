import test from "node:test";
import assert from "node:assert/strict";
import {
  allowanceNotices,
  summarizeUsage,
  usageWindow,
  type FlightUsage,
} from "../server/usage.js";
import { decodeResearchView } from "../src/view-wire.js";
import { researchJobView } from "../src/job-view.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ResearchJobStatusPanel } from "../src/job-status-panel.js";
import sample from "../fixtures/water-procurement.json";
const month = {
  start: "2026-10-01T00:00:00.000Z",
  end: "2026-11-01T00:00:00.000Z",
};
const day = {
  start: "2026-10-18T00:00:00.000Z",
  end: "2026-10-19T00:00:00.000Z",
};
const started = "2026-10-18T12:00:00.000Z";
const event = (id: string, cost = 7000) => ({
  provider: "exa",
  kind: "search",
  status: "completed",
  request_id: id,
  usage: { estimated_cost_microusd: cost, cost_microusd: null },
});
const flight: FlightUsage = {
  run_id: "synthetic-flight",
  job_id: "synthetic-job",
  started_at: started,
  ended_at: "2026-10-18T12:00:10.125Z",
  elapsed_seconds: 10.125,
  instance_type: "F4",
};
const report = (
  receipts: any[] = [],
  flights: FlightUsage[] = [],
  window = month,
) =>
  summarizeUsage(receipts, flights, window, "pg.us-east-1-aws.motherduck.com");

test("the $2 ceiling never becomes spend: six searches cost $0.042 and saved SQL $0", () => {
  const result = report([
    {
      run_id: "r1",
      started_at: started,
      effective_limits: { max_cost_microusd: 2_000_000 },
      events: Array.from({ length: 6 }, (_, i) => event(`req-${i}`)),
    },
    {
      run_id: "saved-sql",
      started_at: started,
      effective_limits: { max_cost_microusd: 2_000_000 },
      events: [],
    },
  ]);
  assert.equal(result.providers[0].estimated_cost_microusd, 42_000);
  assert.equal(result.providers[0].requests, 6);
  assert.equal(result.providers[0].cost_unavailable_requests, 0);
  assert.deepEqual(
    report([{ run_id: "sql", started_at: started, events: [] }]).providers,
    [],
  );
});

test("replayed request IDs deduplicate; failed, cancelled and unknown effects remain metered", () => {
  const receipts = [
    {
      run_id: "failed",
      status: "failed",
      started_at: started,
      events: [
        event("same"),
        {
          provider: "exa",
          kind: "fetch",
          status: "remote_outcome_unknown",
          usage: { cost_microusd: null },
        },
      ],
    },
    {
      run_id: "cancelled",
      status: "cancelled",
      started_at: started,
      events: [event("same"), event("other")],
    },
    {
      run_id: "skipped",
      started_at: started,
      events: [
        { ...event("skip"), status: "not_dispatched" },
        { ...event("cache"), kind: "embedding_cache" },
      ],
    },
  ];
  const result = report(receipts).providers[0];
  assert.equal(result.requests, 3);
  assert.equal(result.estimated_cost_microusd, 14_000);
  assert.equal(result.uncertain_requests, 1);
  assert.equal(result.cost_unavailable_requests, 1);
});

test("Flight runtime is observed, settled once, and excludes unknown database costs", () => {
  const result = report([], [flight, flight]);
  assert.equal(result.motherduck.observed_flights, 1);
  assert.equal(result.motherduck.observed_flight_seconds, 11);
  assert.equal(result.motherduck.estimated_flight_cost_microusd, 458);
  assert.equal(result.motherduck.sql_compute_cost_microusd, null);
  assert.equal(result.motherduck.storage_cost_microusd, null);
  assert.equal(result.motherduck.account_billed_cost_microusd, null);
  assert.equal(
    report([], [flight], { start: month.end, end: "2026-12-01T00:00:00.000Z" })
      .motherduck.observed_flights,
    0,
  );
});

test("model tokens remain reportable without inventing a dollar charge", () => {
  const result = report([
    {
      run_id: "model",
      started_at: started,
      events: [
        {
          kind: "semantic",
          status: "completed",
          usage: { input_tokens: 1000, output_tokens: 10, cost_microusd: null },
        },
      ],
    },
  ]);
  assert.equal(result.providers[0].service, "openai");
  assert.equal(result.providers[0].input_tokens, 1000);
  assert.equal(result.providers[0].cost_unavailable_requests, 1);
});

test("reference crossings are nonblocking and follow Exa monthly / F4 daily periods", () => {
  const monthly = report([
    { run_id: "r", started_at: started, events: [event("exa", 10_000_000)] },
  ]);
  const today = report([], [{ ...flight, elapsed_seconds: 1800 }], day);
  const notices = allowanceNotices(monthly, today);
  assert.deepEqual(
    notices.map((n) => [n.service, n.period, n.blocking]),
    [
      ["exa", "month", false],
      ["motherduck", "day", false],
    ],
  );
  assert(
    notices.every((n) => n.basis === "estimated" && n.scope === "sourcesql"),
  );
  assert.deepEqual(allowanceNotices(report(), report([], [], day)), []);
  assert.equal(allowanceNotices(monthly, today)[0].id, notices[0].id);
});

test("malformed optional notices do not block a valid saved table", () => {
  const decoded = decodeResearchView({
    snapshot: sample,
    amendments: [],
    usageNotices: [{ service: "exa", used: "bad" }],
  });
  assert.equal(decoded.snapshot.id, sample.id);
  assert.deepEqual(decoded.usageNotices, []);
});

test("provider refusals render saved-work recovery without billing consent or automatic replay", () => {
  for (const kind of ["credits", "rate", "spend"] as const) {
    const view = researchJobView({
      job_id: "synthetic-job",
      request_id: "01010101-0101-4101-8101-010101010101",
      status: "failed",
      capacity: {
        resource: "search_model_budget",
        reason: "provider_limit",
        period: "unknown",
        allowance: "unknown",
        services: ["exa"],
        limit_kind: kind,
        http_status: kind === "rate" ? 429 : 402,
      },
    });
    const html = renderToStaticMarkup(
      createElement(ResearchJobStatusPanel, {
        view,
        busy: false,
        onCheck() {},
        onResume() {},
      }),
    );
    assert.match(html, /Completed work is saved/);
    assert.match(html, /https:\/\/dashboard.exa.ai\/billing/);
    assert.doesNotMatch(html, /Free hosted|authorization|Enable paid/);
    assert.match(html, /disabled=""/);
  }
});

test("report intervals are explicit, bounded and UTC-normalized", () => {
  assert.deepEqual(usageWindow({}, new Date(started)), month);
  assert.throws(() => usageWindow({ start: started, end: started }));
  assert.throws(() =>
    usageWindow({ start: "2024-01-01T00:00:00Z", end: "2026-01-01T00:00:00Z" }),
  );
});
