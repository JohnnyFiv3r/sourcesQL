import { createHash } from "node:crypto";
export type HostedExaPolicy = {
  approvedCostMicrousd: number;
  dailyCostMicrousd: number;
  secretName: string;
  policyVersion?: string;
};
export const EXA_SEARCH_TYPES = {
  exa: "auto",
  exa_deep: "deep",
  exa_deep_reasoning: "deep-reasoning",
} as const;
export function exaSearchTypes(policy: HostedExaPolicy) {
  return policy.policyVersion === "exa-research.v2"
    ? EXA_SEARCH_TYPES
    : { exa: "auto" as const };
}
export function exaDeadline(policy: HostedExaPolicy, deadline: number) {
  return Math.min(
    policy.policyVersion === "exa-research.v2" ? 100 : 60,
    deadline,
  );
}
export function isExaProfile(
  profile: unknown,
): profile is keyof typeof EXA_SEARCH_TYPES {
  return (
    typeof profile === "string" && Object.hasOwn(EXA_SEARCH_TYPES, profile)
  );
}
export function exaDescriptor(policy: HostedExaPolicy) {
  if (policy.policyVersion !== "exa-research.v2")
    return {
      approved_cost_microusd: policy.approvedCostMicrousd,
      secret_name: policy.secretName,
      version: "exa-search.v1",
    };
  return {
    approved_cost_microusd: policy.approvedCostMicrousd,
    search_types: EXA_SEARCH_TYPES,
    secret_name: policy.secretName,
    version: "exa-research.v2",
  };
}
export function exaFingerprint(policy: HostedExaPolicy): string {
  return createHash("sha256")
    .update(JSON.stringify(exaDescriptor(policy)))
    .digest("hex");
}
export function validateExaPolicy(policy: HostedExaPolicy): void {
  if (
    !Number.isSafeInteger(policy.approvedCostMicrousd) ||
    policy.approvedCostMicrousd < 1 ||
    policy.approvedCostMicrousd > 1000000 ||
    !Number.isSafeInteger(policy.dailyCostMicrousd) ||
    policy.dailyCostMicrousd < policy.approvedCostMicrousd ||
    policy.dailyCostMicrousd > 1000000 ||
    ![undefined, "exa-search.v1", "exa-research.v2"].includes(
      policy.policyVersion,
    ) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(policy.secretName)
  )
    throw Error("Invalid hosted Exa policy");
}
export function exaBudgets(
  input: Record<string, unknown>,
  policy: HostedExaPolicy,
  deadline: number,
): Record<string, number> {
  const caps: Record<string, number> = {
    max_search_queries: 2,
    max_search_requests: 2,
    max_candidates: 10,
    max_fetches: 0,
    max_semantic_documents: 0,
    max_model_requests: 0,
    max_concurrency: 1,
    dispatch_deadline_seconds: exaDeadline(policy, deadline),
    max_output_rows: 100,
    max_output_bytes: 1048576,
    max_input_tokens: 0,
    max_output_tokens: 0,
    max_cost_microusd: policy.approvedCostMicrousd,
  };
  if (Object.keys(input).some((key) => !(key in caps)))
    throw Error("Unknown hosted Exa budget");
  for (const [key, value] of Object.entries(input)) {
    if (
      !Number.isSafeInteger(value) ||
      Number(value) < 0 ||
      Number(value) > caps[key]
    )
      throw Error("Hosted Exa budget exceeds approval");
    caps[key] = Number(value);
  }
  if (caps.max_cost_microusd < 1)
    throw Error("Hosted Exa requires an approved positive budget");
  return caps;
}
