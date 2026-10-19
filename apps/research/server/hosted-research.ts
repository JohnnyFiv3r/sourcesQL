/** Provider-neutral OpenAI processing selected by the deployment owner. */
export type HostedResearchOptions = {
  model?: { name: string; secretName: string; reasoningEffort?: string };
  embedding?: { name: string; secretName: string };
};

export function canonical<T>(value: T): T {
  if (Array.isArray(value)) return value.map(canonical) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    ) as T;
  return value;
}

/** Keep absent adapters distinct from malformed or unapproved adapters. */
export function validHostedResearchOptions(
  policy: HostedResearchOptions,
  enabled: boolean,
): boolean {
  return !(
    (policy.embedding !== undefined &&
      (!enabled ||
        !policy.embedding ||
        typeof policy.embedding !== "object" ||
        Array.isArray(policy.embedding) ||
        Object.keys(policy.embedding).some(
          (key) => !["name", "secretName"].includes(key),
        ) ||
        !["text-embedding-3-small", "text-embedding-3-large"].includes(
          policy.embedding.name,
        ) ||
        typeof policy.embedding.secretName !== "string" ||
        !/^[a-z][a-z0-9_]{0,62}$/.test(policy.embedding.secretName))) ||
    (policy.model !== undefined &&
      (!enabled ||
        policy.model === null ||
        typeof policy.model !== "object" ||
        Array.isArray(policy.model) ||
        Object.keys(policy.model).some(
          (key) => !["name", "secretName", "reasoningEffort"].includes(key),
        ) ||
        !Object.hasOwn(policy.model, "name") ||
        !Object.hasOwn(policy.model, "secretName") ||
        typeof policy.model.name !== "string" ||
        !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(policy.model.name) ||
        typeof policy.model.secretName !== "string" ||
        !/^[a-z][a-z0-9_]{0,62}$/.test(policy.model.secretName) ||
        (policy.model.reasoningEffort !== undefined &&
          !["low", "medium", "high", "xhigh", "max"].includes(
            policy.model.reasoningEffort,
          ))))
  );
}

export function hostedResearchLimits(
  policy: HostedResearchOptions,
): Record<string, number> {
  return canonical({
    max_search_queries: 32,
    max_search_requests: 48,
    max_candidates: 2500,
    max_fetches: 40,
    max_semantic_documents: policy.model ? 40 : 0,
    max_model_requests: policy.model || policy.embedding ? 96 : 0,
    max_concurrency: 4,
    dispatch_deadline_seconds: 100,
    max_output_rows: 1000,
    max_output_bytes: 4_194_304,
    max_input_tokens: policy.model || policy.embedding ? 200_000 : 0,
    max_output_tokens: policy.model ? 16_000 : 0,
  });
}

export function hostedResearchOperators(
  policy: HostedResearchOptions,
): string[] {
  return [
    "WEB_SEARCH",
    "WEB_FETCH",
    ...(policy.model
      ? ["SEM_MATCH", "SEM_EXTRACT", "SEM_EXTRACT_ALL", "SEM_NORM"]
      : []),
    ...(policy.embedding ? ["SEM_SCORE"] : []),
  ];
}

export function hostedResearchConfiguration(
  policy: HostedResearchOptions,
): Record<string, string> {
  return {
    ...(policy.embedding
      ? {
          SOURCESQL_OPENAI_EMBEDDING_MODEL: policy.embedding.name,
          SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME: policy.embedding.secretName,
        }
      : {}),
    ...(policy.model
      ? {
          SOURCESQL_OPENAI_MODEL: policy.model.name,
          SOURCESQL_OPENAI_SECRET_NAME: policy.model.secretName,
          ...(policy.model.reasoningEffort !== undefined
            ? {
                SOURCESQL_OPENAI_REASONING_EFFORT: policy.model.reasoningEffort,
              }
            : {}),
        }
      : {}),
  };
}
