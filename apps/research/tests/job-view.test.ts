import test from "node:test";
import assert from "node:assert/strict";
import { decodeResearchJobView, researchJobView } from "../src/job-view.js";

const legacyCapacity = {
  resource: "search_model_budget",
  reason: "provider_limit",
  period: "unknown",
  allowance: "unknown",
  services: ["exa"],
};
const legacy = {
  kind: "research_job_status",
  job: {
    job_id: "fixture-job",
    request_id: "ebeb10cc-e869-46c8-8070-514443fe570a",
    status: "queued",
    pending: true,
    can_resume: false,
    capacity: legacyCapacity,
  },
};
const capacity = {
  ...legacyCapacity,
  limit_kind: "rate",
  http_status: 429,
  retry_after_seconds: 45,
};
const notice = {
  id: "e".repeat(64),
  service: "exa",
  period: "month",
  period_start: "2026-10-01T00:00:00.000Z",
  period_end: "2026-11-01T00:00:00.000Z",
  used: 10_020_000,
  allowance: 10_000_000,
  unit: "microusd",
  basis: "estimated",
  scope: "sourcesql",
  blocking: false,
};
function metadata(values: Record<string, unknown> = {}) {
  return {
    sourcesqlJobPresentationV1: {
      job_id: legacy.job.job_id,
      capacity,
      usageNotices: [notice],
      ...values,
    },
  };
}

test("published kind/job envelope and legacy capacity remain readable without presentation metadata", () => {
  const view = decodeResearchJobView(legacy);
  assert.deepEqual(view, legacy);
  assert.deepEqual(Object.keys(view).sort(), ["job", "kind"]);
  assert.equal(view.usageNotices, undefined);
  assert.equal(view.job.capacity?.limit_kind, undefined);
});

test("matching presentation metadata restores provider detail and usage notices without changing the legacy payload", () => {
  const before = structuredClone(legacy);
  const view = decodeResearchJobView(legacy, metadata());
  assert.deepEqual(view.usageNotices, [notice]);
  assert.deepEqual(view.job.capacity, capacity);
  assert.equal(view.job.job_id, legacy.job.job_id);
  assert.deepEqual(legacy, before);
});

test("malformed or mismatched optional metadata never rejects a valid legacy job", () => {
  for (const meta of [
    null,
    [],
    { sourcesqlJobPresentationV1: null },
    metadata({ job_id: "some-other-job" }),
    metadata({ capacity: { ...capacity, http_status: 500 } }),
    metadata({ usageNotices: [{ ...notice, blocking: true }] }),
    metadata({ unexpected: "future incompatible field" }),
  ]) {
    assert.deepEqual(decodeResearchJobView(legacy, meta), legacy);
  }
});

test("presentation metadata cannot make an invalid base job valid", () => {
  assert.throws(() =>
    decodeResearchJobView(
      { ...legacy, job: { ...legacy.job, status: "invented" } },
      metadata(),
    ),
  );
});

test("current receipt checks prefer valid provider capacity and fall back to the legacy capacity", () => {
  const receipt = { ...legacy.job, provider_capacity_v1: capacity };
  assert.deepEqual(researchJobView(receipt).job.capacity, capacity);
  for (const optional of [
    undefined,
    null,
    { ...capacity, retry_after_seconds: -1 },
  ]) {
    assert.deepEqual(
      researchJobView({ ...receipt, provider_capacity_v1: optional }).job
        .capacity,
      legacyCapacity,
    );
  }
});
