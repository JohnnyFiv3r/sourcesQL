/** Interpret only the supplied workload outcomes. Detailed evidence belongs in
 * ignored reports, never as an expected benchmark result in tracked source. */
export function workspaceStorageDecision(
  cases: readonly { firstRefusal: { operation: string } | null }[],
) {
  const guidance =
    "Keep current limits. Review current-state/history deltas and per-operation SQL/resolver samples before proposing a separate storage change. Preserve reconstruction, authorization, CAS and acknowledgement recovery; do not prune history or raise allowances to complete a fixture. Obtain remote measurements before drawing hosted latency conclusions.";
  if (cases.length === 0)
    return {
      retainProductionLimits: true,
      cause:
        "No workload measurements were recorded; storage behavior has not been evaluated.",
      next:
        "Run the local workload matrix and inspect its samples before selecting a storage follow-up. " +
        guidance,
    };
  if (cases.some((value) => value.firstRefusal !== null))
    return {
      retainProductionLimits: true,
      cause:
        "At least one measured workload stopped at a configured allowance. A refusal alone does not identify the limiting resource or a storage bottleneck.",
      next:
        "Inspect each first-refusal sample and its preceding growth before selecting a storage follow-up. " +
        guidance,
    };
  return {
    retainProductionLimits: true,
    cause:
      "No configured allowance refusal was recorded in the supplied workload cases. This establishes only their measured envelope.",
    next:
      "Retain the storage implementation within the measured envelope; justify any follow-up from the recorded growth and operation samples. " +
      guidance,
  };
}
