import test from "node:test";
import assert from "node:assert/strict";
import { safeExecutionError } from "../server/execution-errors.js";

test("an admission refusal reason is returned with the fixed invalid_query summary", () => {
  const error = safeExecutionError(
    "invalid_query",
    "SQL could not be parsed in the installed dialect",
  );
  assert.equal(error.code, "invalid_query");
  assert.equal(error.reason, "SQL could not be parsed in the installed dialect");
  assert.match(error.message, /could not be executed/);
  assert.match(error.message, /SQL could not be parsed in the installed dialect/);
});

test("refusal reasons are dropped for other codes and for text outside the fixed vocabulary", () => {
  for (const [code, reason] of [
    ["provider_error", "SQL could not be parsed in the installed dialect"],
    ["not_a_code", "SQL could not be parsed in the installed dialect"],
    ["invalid_query", 'PRIVATE "secret" <script>'],
    ["invalid_query", "line\nbreak"],
    ["invalid_query", "x".repeat(241)],
    ["invalid_query", ""],
    ["invalid_query", { toString: () => "x" }],
  ] as const) {
    const error = safeExecutionError(code, reason);
    assert.equal(error.reason, undefined);
    assert.ok(!error.message.includes("PRIVATE"));
    assert.ok(!error.message.includes("Admission refused"));
  }
  assert.deepEqual(safeExecutionError("invalid_query"), {
    code: "invalid_query",
    message:
      "The query could not be executed. Review its SQL and input bindings before starting new work.",
  });
});

test("shared codes keep their own code on the hosted job path", () => {
  for (const code of [
    "not_found",
    "result_unavailable",
    "idempotency_conflict",
    "revision_conflict",
  ])
    assert.equal(safeExecutionError(code).code, code);
  assert.equal(safeExecutionError("not_in_the_table").code, "execution_failed");
});
