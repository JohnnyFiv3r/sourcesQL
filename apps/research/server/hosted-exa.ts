import { createHash } from "node:crypto";
import {
  canonical,
  hostedResearchConfiguration,
  hostedResearchLimits,
  hostedResearchOperators,
  validHostedResearchOptions,
  type HostedResearchOptions,
} from "./hosted-research.ts";
export type HostedExaPolicy = HostedResearchOptions & {
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
  validateExaPolicy(policy);
  return ["exa-research.v2", "exa-research.v3"].includes(
    policy.policyVersion ?? "",
  )
    ? EXA_SEARCH_TYPES
    : { exa: "auto" as const };
}
export function exaDeadline(policy: HostedExaPolicy, deadline: number) {
  validateExaPolicy(policy);
  if (!Number.isSafeInteger(deadline) || deadline < 1)
    throw Error("Invalid hosted Exa deadline");
  return Math.min(
    ["exa-research.v2", "exa-research.v3"].includes(policy.policyVersion ?? "")
      ? 100
      : 60,
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
  validateExaPolicy(policy);
  if (policy.policyVersion === "exa-research.v3")
    return canonical({
      approved_cost_microusd: policy.approvedCostMicrousd,
      limits: exaResearchLimits(policy),
      ...(policy.embedding
        ? {
            embedding: {
              name: policy.embedding.name,
              secret_name: policy.embedding.secretName,
              version: "openai-embeddings.v2",
            },
          }
        : {}),
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
      search_types: EXA_SEARCH_TYPES,
      secret_name: policy.secretName,
      version: "exa-research.v3",
    });
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
  const research = policy.policyVersion === "exa-research.v3";
  if (
    !Number.isSafeInteger(policy.approvedCostMicrousd) ||
    policy.approvedCostMicrousd < 1 ||
    policy.approvedCostMicrousd > (research ? 2_000_000 : 1_000_000) ||
    !Number.isSafeInteger(policy.dailyCostMicrousd) ||
    policy.dailyCostMicrousd < policy.approvedCostMicrousd ||
    // Trusted operator configuration ceiling; defaults and spending grants are separate.
    policy.dailyCostMicrousd > (research ? 50_000_000 : 1_000_000) ||
    ![
      undefined,
      "exa-search.v1",
      "exa-research.v2",
      "exa-research.v3",
    ].includes(policy.policyVersion) ||
    typeof policy.secretName !== "string" ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(policy.secretName) ||
    !validHostedResearchOptions(policy, research)
  )
    throw Error("Invalid hosted Exa policy");
}

export function exaResearchLimits(
  policy: HostedExaPolicy,
): Record<string, number> {
  validateExaPolicy(policy);
  if (policy.policyVersion !== "exa-research.v3")
    return {
      max_search_queries: 2,
      max_search_requests: 2,
      max_candidates: 10,
      max_fetches: 0,
      max_semantic_documents: 0,
      max_model_requests: 0,
      max_concurrency: 1,
      dispatch_deadline_seconds: exaDeadline(policy, 100),
      max_output_rows: 100,
      max_output_bytes: 1_048_576,
      max_input_tokens: 0,
      max_output_tokens: 0,
    };
  return hostedResearchLimits(policy);
}

export function exaOperators(policy: HostedExaPolicy): string[] {
  validateExaPolicy(policy);
  if (policy.policyVersion !== "exa-research.v3") return ["WEB_SEARCH"];
  return hostedResearchOperators(policy);
}

export function exaConfiguration(
  policy: HostedExaPolicy,
): Record<string, string> {
  const descriptor = exaDescriptor(policy);
  return {
    SOURCESQL_ALLOW_LIVE_EXA: "1",
    SOURCESQL_EXA_POLICY_VERSION: descriptor.version,
    SOURCESQL_EXA_APPROVED_COST_MICROUSD: String(policy.approvedCostMicrousd),
    SOURCESQL_EXA_SECRET_NAME: policy.secretName,
    ...hostedResearchConfiguration(policy),
  };
}
export function exaBudgets(
  input: Record<string, unknown>,
  policy: HostedExaPolicy,
  deadline: number,
): Record<string, number> {
  validateExaPolicy(policy);
  const caps: Record<string, number> = {
    ...exaResearchLimits(policy),
    dispatch_deadline_seconds: exaDeadline(policy, deadline),
    max_cost_microusd: policy.approvedCostMicrousd,
  };
  if (Object.keys(input).some((key) => !Object.hasOwn(caps, key)))
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
