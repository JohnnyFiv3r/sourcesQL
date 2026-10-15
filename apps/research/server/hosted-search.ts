import { createHash } from "node:crypto";

/** One operator-selected search provider per reviewed Flight. */
export type HostedSearchPolicy = {
  provider: "brave" | "serper";
  secretName: string;
  approvedCostMicrousd: number;
  dailyCostMicrousd: number;
  requestCostMicrousd: number;
};
export const HOSTED_SEARCH_POLICY_VERSIONS = {
  brave: "brave-search.v1",
  serper: "serper-search.v1",
} as const;
export const HOSTED_SEARCH_LIMITS = {
  max_search_queries: 2,
  max_search_requests: 2,
  max_candidates: 10,
  max_fetches: 0,
  max_semantic_documents: 0,
  max_model_requests: 0,
  max_concurrency: 1,
  dispatch_deadline_seconds: 60,
  max_output_rows: 100,
  max_output_bytes: 1_048_576,
  max_input_tokens: 0,
  max_output_tokens: 0,
} as const;

export function isHostedSearchProfile(
  profile: unknown,
): profile is "brave" | "serper" {
  return profile === "brave" || profile === "serper";
}

export function validateHostedSearchPolicy(policy: HostedSearchPolicy): void {
  if (
    !isHostedSearchProfile(policy.provider) ||
    typeof policy.secretName !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(policy.secretName) ||
    ![
      policy.approvedCostMicrousd,
      policy.dailyCostMicrousd,
      policy.requestCostMicrousd,
    ].every(
      (value) =>
        Number.isSafeInteger(value) && value >= 1 && value <= 1_000_000,
    ) ||
    policy.dailyCostMicrousd < policy.approvedCostMicrousd ||
    policy.requestCostMicrousd > policy.approvedCostMicrousd
  )
    throw Error("Invalid hosted search policy");
}

export function hostedSearchDescriptor(policy: HostedSearchPolicy) {
  validateHostedSearchPolicy(policy);
  // Key order is canonical and matches the trusted Python Flight helper.
  return {
    approved_cost_microusd: policy.approvedCostMicrousd,
    provider: policy.provider,
    request_cost_microusd: policy.requestCostMicrousd,
    secret_name: policy.secretName,
    version: HOSTED_SEARCH_POLICY_VERSIONS[policy.provider],
  };
}

export function hostedSearchFingerprint(policy: HostedSearchPolicy): string {
  return createHash("sha256")
    .update(JSON.stringify(hostedSearchDescriptor(policy)))
    .digest("hex");
}

export function hostedSearchBudgets(
  input: Record<string, unknown>,
  policy: HostedSearchPolicy,
  deadline: number,
): Record<string, number> {
  validateHostedSearchPolicy(policy);
  const caps: Record<string, number> = {
    ...HOSTED_SEARCH_LIMITS,
    dispatch_deadline_seconds: Math.min(60, deadline),
    max_cost_microusd: policy.approvedCostMicrousd,
  };
  if (Object.keys(input).some((key) => !Object.hasOwn(caps, key)))
    throw Error("Unknown hosted search budget");
  for (const [key, value] of Object.entries(input)) {
    if (
      !Number.isSafeInteger(value) ||
      Number(value) < 0 ||
      Number(value) > caps[key]
    )
      throw Error("Hosted search budget exceeds approval");
    caps[key] = Number(value);
  }
  if (caps.max_cost_microusd < policy.requestCostMicrousd)
    throw Error("Hosted search budget cannot cover one estimated request");
  // API billing is unavailable. Bound attempts by the operator's conservative
  // per-request estimate and reserve the complete job grant before dispatch.
  const affordable = Math.floor(
    caps.max_cost_microusd / policy.requestCostMicrousd,
  );
  caps.max_search_requests = Math.min(caps.max_search_requests, affordable);
  caps.max_search_queries = Math.min(
    caps.max_search_queries,
    caps.max_search_requests,
  );
  return caps;
}

export function hostedSearchConfiguration(
  policy: HostedSearchPolicy,
): Record<string, string> {
  const descriptor = hostedSearchDescriptor(policy);
  const prefix = `SOURCESQL_${policy.provider.toUpperCase()}`;
  return {
    [`SOURCESQL_ALLOW_LIVE_${policy.provider.toUpperCase()}`]: "1",
    [`${prefix}_POLICY_VERSION`]: descriptor.version,
    [`${prefix}_SECRET_NAME`]: policy.secretName,
    [`${prefix}_APPROVED_COST_MICROUSD`]: String(policy.approvedCostMicrousd),
    [`${prefix}_REQUEST_COST_MICROUSD`]: String(policy.requestCostMicrousd),
  };
}
