/** Public summaries use fixed text; stored/provider error strings stay private. */
export const messages: Record<string, string> = {
  unsupported_query:
    "The query is not supported. Review its SQL against sourcesql_capabilities before starting new work.",
  invalid_query:
    "The query could not be executed. Review its SQL and input bindings before starting new work.",
  invalid_request:
    "The request is invalid. Review its arguments before starting new work.",
  budget_exhausted:
    "A configured execution allowance was exhausted. Inspect this job or run before authorizing further work.",
  unsupported_capability:
    "A required capability is unavailable in this configuration. Check sourcesql_capabilities before starting new work.",
  unauthorized: "The operation is not authorized for this connection.",
  disclosure_required:
    "The operation requires explicit disclosure authorization.",
  evidence_invalid:
    "Source evidence failed validation. Inspect the saved run before continuing.",
  invalid_output:
    "Research output failed validation. Inspect the saved run before continuing.",
  provider_unavailable:
    "A required provider or dependency is unavailable. Inspect this job or run before continuing.",
  provider_timeout:
    "A provider request timed out. Its remote outcome may be unknown; inspect the saved run before retrying.",
  provider_connection_error:
    "A provider connection failed. Its remote outcome may be unknown; inspect the saved run before retrying.",
  provider_http_error:
    "A provider rejected a request. Inspect the saved run before continuing.",
  provider_error:
    "A provider request failed. Inspect the saved run before continuing.",
  storage_conflict:
    "Stored state changed concurrently. Inspect this job or run before continuing.",
  storage_unavailable:
    "Durable storage is unavailable. Inspect this job or run before continuing.",
  cancelled:
    "Execution was cancelled. No further work starts from status inspection.",
  flight_definition_changed:
    "The pinned worker configuration changed. Review the worker configuration before starting new work.",
  execution_outcome_unknown:
    "Execution outcome is unknown. Inspect this job or run; do not automatically resubmit it.",
  execution_failed:
    "Research execution failed safely. Inspect this job or run before continuing.",
  not_found: "Not found.",
  result_unavailable: "Result or dependency unavailable.",
  idempotency_conflict:
    "That request ID was already used with different parameters. Use a new request ID, or repeat the original request unchanged.",
  revision_conflict:
    "The research changed since you read it. Reread it and apply your change again.",
};

export const knownErrorCode = (code: string): boolean =>
  Object.hasOwn(messages, code);

/** Admission's own refusal sentences: fixed text, never query text or values. */
const refusalCodes = new Set(["invalid_query", "unsupported_query"]);
const refusalReason = /^[A-Za-z0-9 ,.;:()_'-]{1,240}$/;

export function safeExecutionError(
  code: unknown,
  reason?: unknown,
): {
  code: string;
  message: string;
  reason?: string;
} {
  const safeCode =
    typeof code === "string" && Object.hasOwn(messages, code)
      ? code
      : "execution_failed";
  const safeReason =
    refusalCodes.has(safeCode) &&
    typeof reason === "string" &&
    refusalReason.test(reason)
      ? reason
      : undefined;
  return safeReason
    ? {
        code: safeCode,
        message: `${messages[safeCode]} Admission refused it: ${safeReason}.`,
        reason: safeReason,
      }
    : { code: safeCode, message: messages[safeCode] };
}

const stages = new Set([
  "admission",
  "dispatch",
  "acquisition",
  "fetch",
  "semantic",
  "worker",
  "execution",
  "publish",
  "storage",
  "jobs",
  "read",
]);

/** A bounded diagnostic view, never a provider receipt/body or an arbitrary message. */
export function safeRunErrors(errors: unknown) {
  if (!Array.isArray(errors)) return [];
  return errors.slice(0, 8).flatMap((error: unknown) => {
    if (!error || typeof error !== "object" || Array.isArray(error)) return [];
    const record = error as Record<string, unknown>;
    return [
      {
        ...safeExecutionError(record.code),
        ...(typeof record.stage === "string" && stages.has(record.stage)
          ? { stage: record.stage }
          : {}),
      },
    ];
  });
}

export function safeFailureContext(context: unknown) {
  if (!context || typeof context !== "object") return {};
  const value = context as Record<string, unknown>;
  return {
    ...(typeof value.stage === "string" && stages.has(value.stage) ? { stage: value.stage } : {}),
    ...(typeof value.provider_dispatch === "string" && ["not_dispatched", "settled", "rejected", "outcome_unknown"].includes(value.provider_dispatch)
      ? { provider_dispatch: value.provider_dispatch } : {}),
  };
}
