import test from "node:test";
import assert from "node:assert/strict";
import { workspaceStorageDecision } from "../scripts/workspace-report.js";

test("workspace decision uses supplied workload outcomes rather than a previous measurement", () => {
  const complete = [
    {
      firstRefusal: null,
      final: { stateBytes: 300, historyBytes: 700 },
      resolverCalls: 2,
    },
    {
      firstRefusal: null,
      final: { stateBytes: 900, historyBytes: 1800 },
      resolverCalls: 4,
    },
  ];
  const refused = [
    {
      firstRefusal: {
        operation: "checkpoint",
        stateBytes: 600,
        historyBytes: 2000,
      },
      resolverCalls: 3,
    },
    complete[1],
  ];
  const passedDecision = workspaceStorageDecision(complete),
    refusedDecision = workspaceStorageDecision(refused);
  assert.equal(passedDecision.retainProductionLimits, true);
  assert.equal(refusedDecision.retainProductionLimits, true);
  assert.match(passedDecision.cause, /No configured allowance refusal/);
  assert.match(refusedDecision.cause, /At least one measured workload/);
  assert.notEqual(passedDecision.next, refusedDecision.next);
  assert.match(refusedDecision.next, /Inspect each first-refusal sample/);
  assert.match(
    refusedDecision.cause,
    /does not identify the limiting resource/,
  );
});

test("workspace decision does not claim measurements or a bottleneck for an empty matrix", () => {
  const decision = workspaceStorageDecision([]);
  assert.match(decision.cause, /No workload measurements were recorded/);
  assert.match(decision.next, /Run the local workload matrix/);
  assert.match(decision.next, /Obtain remote measurements/);
});

test("workspace decision leaves detailed inputs unchanged and makes no fixed growth or resolver claim", () => {
  const input = [
    {
      firstRefusal: null,
      final: { stateBytes: 2048, historyBytes: 0 },
      samples: [{ resolverCalls: 0 }],
    },
  ];
  const before = structuredClone(input),
    first = workspaceStorageDecision(input);
  const differentMeasurements = [
    {
      firstRefusal: null,
      final: { stateBytes: 1, historyBytes: 1000000 },
      samples: [{ resolverCalls: 500 }],
    },
  ];
  const contrasting = workspaceStorageDecision(differentMeasurements);
  assert.deepEqual(input, before);
  assert.deepEqual(
    first,
    contrasting,
    "Without a measured causal diagnosis, guidance stays neutral across byte/resolver differences",
  );
  assert.match(first.next, /Review current-state\/history deltas/);
  assert.match(first.next, /Preserve reconstruction, authorization, CAS/);
  assert.doesNotMatch(
    first.next,
    /approximately|observed resolver calls|complete current states/,
  );
});
