import { createHash } from "node:crypto";
import {
  canonical,
  hostedResearchConfiguration,
  hostedResearchLimits,
  hostedResearchOperators,
  validHostedResearchOptions,
  type HostedResearchOptions,
} from "./hosted-research.ts";

/** One operator-selected search provider per reviewed Flight. */
export type HostedSearchPolicy = HostedResearchOptions & {
  provider: "brave" | "serper";
  secretName: string;
  approvedCostMicrousd: number;
  dailyCostMicrousd: number;
  requestCostMicrousd: number;
  policyVersion?: string;
};
export const HOSTED_SEARCH_POLICY_VERSIONS = {
  brave: "brave-search.v1",
  serper: "serper-search.v1",
} as const;
export const HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS = {
  brave: "brave-research.v2",
  serper: "serper-research.v2",
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
  const research = isHostedSearchResearch(policy);
  if (
    !isHostedSearchProfile(policy.provider) ||
    typeof policy.secretName !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(policy.secretName) ||
    ![
      [policy.approvedCostMicrousd, research ? 2_000_000 : 1_000_000],
      [policy.dailyCostMicrousd, research ? 50_000_000 : 1_000_000],
      [policy.requestCostMicrousd, 1_000_000],
    ].every(
      ([value, maximum]) =>
        Number.isSafeInteger(value) && value >= 1 && value <= maximum,
    ) ||
    policy.dailyCostMicrousd < policy.approvedCostMicrousd ||
    policy.requestCostMicrousd > policy.approvedCostMicrousd ||
    (policy.policyVersion !== undefined &&
      ![
        HOSTED_SEARCH_POLICY_VERSIONS[policy.provider],
        HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS[policy.provider],
      ].some((version) => version === policy.policyVersion)) ||
    !validHostedResearchOptions(policy, research)
  )
    throw Error("Invalid hosted search policy");
}

export function hostedSearchDescriptor(policy: HostedSearchPolicy) {
  validateHostedSearchPolicy(policy);
  if (isHostedSearchResearch(policy))
    return canonical({
      approved_cost_microusd: policy.approvedCostMicrousd,
      provider: policy.provider,
      request_cost_microusd: policy.requestCostMicrousd,
      secret_name: policy.secretName,
      version: HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS[policy.provider],
      limits: hostedResearchLimits(policy),
      model: policy.model
        ? {
            name: policy.model.name,
            secret_name: policy.model.secretName,
            version: "openai-structured.v1",
            ...(policy.model.reasoningEffort !== undefined
              ? { reasoning_effort: policy.model.reasoningEffort }
              : {}),
          }
        : null,
      ...(policy.embedding
        ? {
            embedding: {
              name: policy.embedding.name,
              secret_name: policy.embedding.secretName,
              version: "openai-embeddings.v2",
            },
          }
        : {}),
    });
  // Key order is canonical and matches the trusted Python Flight helper.
  return {
    approved_cost_microusd: policy.approvedCostMicrousd,
    provider: policy.provider,
    request_cost_microusd: policy.requestCostMicrousd,
    secret_name: policy.secretName,
    version: HOSTED_SEARCH_POLICY_VERSIONS[policy.provider],
  };
}

export function isHostedSearchResearch(policy: HostedSearchPolicy): boolean {
  return (
    policy.policyVersion !== undefined &&
    policy.policyVersion ===
      HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS[policy.provider]
  );
}

export function hostedSearchLimits(
  policy: HostedSearchPolicy,
): Record<string, number> {
  validateHostedSearchPolicy(policy);
  return isHostedSearchResearch(policy)
    ? hostedResearchLimits(policy)
    : { ...HOSTED_SEARCH_LIMITS };
}

export function hostedSearchOperators(policy: HostedSearchPolicy): string[] {
  validateHostedSearchPolicy(policy);
  return isHostedSearchResearch(policy)
    ? hostedResearchOperators(policy)
    : ["WEB_SEARCH"];
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
  if (!Number.isSafeInteger(deadline) || deadline < 1)
    throw Error("Invalid hosted search deadline");
  const limits = hostedSearchLimits(policy);
  const caps: Record<string, number> = {
    ...limits,
    dispatch_deadline_seconds: Math.min(
      limits.dispatch_deadline_seconds,
      deadline,
    ),
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
  // per-search-request estimate and reserve the complete job grant before
  // dispatch. This bounds search attempts, not model or embedding billing.
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
    ...hostedResearchConfiguration(policy),
  };
}
