import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  hostedSearchBudgets,
  hostedSearchConfiguration,
  hostedSearchDescriptor,
  hostedSearchFingerprint,
  hostedSearchLimits,
  hostedSearchOperators,
  isHostedSearchResearch,
  validateHostedSearchPolicy,
  type HostedSearchPolicy,
} from "../server/hosted-search.js";
import {
  exaDescriptor,
  exaFingerprint,
  exaResearchLimits,
} from "../server/hosted-exa.js";

for (const provider of ["brave", "serper"] as const) {
  const policy: HostedSearchPolicy = {
    provider,
    secretName: `sourcesql_${provider}`,
    approvedCostMicrousd: 50_000,
    dailyCostMicrousd: 100_000,
    requestCostMicrousd: 5_000,
  };
  test(`${provider} policy has canonical token-free descriptor and bound Flight configuration`, () => {
    assert.deepEqual(hostedSearchDescriptor(policy), {
      approved_cost_microusd: 50_000,
      provider,
      request_cost_microusd: 5_000,
      secret_name: `sourcesql_${provider}`,
      version: `${provider}-search.v1`,
    });
    assert.equal(
      hostedSearchFingerprint(policy),
      createHash("sha256")
        .update(JSON.stringify(hostedSearchDescriptor(policy)))
        .digest("hex"),
    );
    const config = hostedSearchConfiguration(policy);
    assert.equal(config[`SOURCESQL_ALLOW_LIVE_${provider.toUpperCase()}`], "1");
    assert.equal(
      config[`SOURCESQL_${provider.toUpperCase()}_REQUEST_COST_MICROUSD`],
      "5000",
    );
    assert.ok(!JSON.stringify(config).includes("API_KEY"));
    assert.notEqual(
      hostedSearchFingerprint(policy),
      hostedSearchFingerprint({ ...policy, requestCostMicrousd: 5_001 }),
    );
  });
  test(`${provider} cost estimate bounds attempts and all expensive operations stay unavailable`, () => {
    const budgets = hostedSearchBudgets(
      { max_cost_microusd: 5_000 },
      policy,
      100,
    );
    assert.equal(budgets.max_search_requests, 1);
    assert.equal(budgets.max_search_queries, 1);
    assert.equal(budgets.max_candidates, 10);
    assert.equal(budgets.dispatch_deadline_seconds, 60);
    for (const field of [
      "max_fetches",
      "max_model_requests",
      "max_semantic_documents",
      "max_input_tokens",
      "max_output_tokens",
    ])
      assert.equal(budgets[field], 0);
    assert.equal(
      hostedSearchBudgets({}, policy, 40).dispatch_deadline_seconds,
      40,
    );
    for (const input of [
      { max_search_requests: 3 },
      { max_search_queries: 3 },
      { max_cost_microusd: 4_999 },
      { max_candidates: 11 },
      { max_fetches: 1 },
      { max_model_requests: 1 },
      { max_concurrency: 2 },
      { unexpected: 1 },
      { max_cost_microusd: Number.NaN },
    ])
      assert.throws(() => hostedSearchBudgets(input, policy, 100));
  });
  test(`${provider} approval fields cannot be missing, unbounded or untrusted names`, () => {
    for (const override of [
      { requestCostMicrousd: 0 },
      { requestCostMicrousd: 50_001 },
      { requestCostMicrousd: 1.5 },
      { dailyCostMicrousd: 49_999 },
      { dailyCostMicrousd: 1_000_001 },
      { approvedCostMicrousd: Infinity },
      { secretName: "UPPERCASE" },
      { secretName: "name'quoted" },
      { provider: "unknown" },
    ])
      assert.throws(() =>
        validateHostedSearchPolicy({
          ...policy,
          ...override,
        } as HostedSearchPolicy),
      );
  });

  const research = (model = false, embedding = false): HostedSearchPolicy => ({
    ...policy,
    policyVersion: `${provider}-research.v2`,
    approvedCostMicrousd: 1_000_000,
    dailyCostMicrousd: 5_000_000,
    ...(model
      ? {
          model: {
            name: "gpt-4.1-mini",
            secretName: "sourcesql_model",
            reasoningEffort: "low",
          },
        }
      : {}),
    ...(embedding
      ? {
          embedding: {
            name: "text-embedding-3-small",
            secretName: "sourcesql_embedding",
          },
        }
      : {}),
  });

  test(`${provider} legacy profiles require an explicit research version before semantic enablement`, () => {
    assert.equal(isHostedSearchResearch(policy), false);
    assert.deepEqual(hostedSearchOperators(policy), ["WEB_SEARCH"]);
    assert.deepEqual(hostedSearchLimits(policy), {
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
    });
    assert.deepEqual(
      hostedSearchDescriptor({
        ...policy,
        policyVersion: `${provider}-search.v1`,
      }),
      hostedSearchDescriptor(policy),
    );
    for (const options of [
      { model: research(true).model },
      { embedding: research(false, true).embedding },
    ])
      assert.throws(() =>
        validateHostedSearchPolicy({ ...policy, ...options }),
      );
  });

  for (const model of [false, true])
    for (const embedding of [false, true])
      test(`${provider} research model=${model} embedding=${embedding} enables only configured processing`, () => {
        const selected = research(model, embedding);
        assert.equal(isHostedSearchResearch(selected), true);
        assert.deepEqual(hostedSearchOperators(selected), [
          "WEB_SEARCH",
          "WEB_FETCH",
          ...(model
            ? ["SEM_MATCH", "SEM_EXTRACT", "SEM_EXTRACT_ALL", "SEM_NORM"]
            : []),
          ...(embedding ? ["SEM_SCORE"] : []),
        ]);
        assert.deepEqual(
          hostedSearchLimits(selected),
          exaResearchLimits({ ...selected, policyVersion: "exa-research.v3" }),
        );
        const caps = hostedSearchBudgets({}, selected, 120);
        assert.equal(caps.dispatch_deadline_seconds, 100);
        assert.equal(caps.max_fetches, 40);
        assert.equal(caps.max_semantic_documents, model ? 40 : 0);
        assert.equal(caps.max_model_requests, model || embedding ? 96 : 0);
        assert.equal(caps.max_output_tokens, model ? 16_000 : 0);
        assert.equal(
          hostedSearchBudgets({}, selected, 70).dispatch_deadline_seconds,
          70,
        );
        for (const [key, ceiling] of Object.entries(caps))
          assert.throws(
            () => hostedSearchBudgets({ [key]: ceiling + 1 }, selected, 100),
            key,
          );
        const config = hostedSearchConfiguration(selected);
        assert.equal(
          config[`SOURCESQL_${provider.toUpperCase()}_POLICY_VERSION`],
          `${provider}-research.v2`,
        );
        assert.equal(config.SOURCESQL_OPENAI_MODEL, selected.model?.name);
        assert.equal(
          config.SOURCESQL_OPENAI_SECRET_NAME,
          selected.model?.secretName,
        );
        assert.equal(
          config.SOURCESQL_OPENAI_REASONING_EFFORT,
          selected.model?.reasoningEffort,
        );
        assert.equal(
          config.SOURCESQL_OPENAI_EMBEDDING_MODEL,
          selected.embedding?.name,
        );
        assert.equal(
          config.SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME,
          selected.embedding?.secretName,
        );
        assert.ok(!JSON.stringify(config).includes("API_KEY"));
      });

  test(`${provider} research fingerprint binds processing settings but excludes the daily operator cap`, () => {
    const selected = research(true, true);
    const fingerprint = hostedSearchFingerprint(selected);
    assert.equal(
      fingerprint,
      hostedSearchFingerprint({ ...selected, dailyCostMicrousd: 50_000_000 }),
    );
    for (const override of [
      { model: undefined },
      { embedding: undefined },
      { model: { ...selected.model!, reasoningEffort: "high" } },
      { model: { ...selected.model!, name: "gpt-4.1" } },
      { model: { ...selected.model!, secretName: "rotated_model" } },
      { embedding: { ...selected.embedding!, name: "text-embedding-3-large" } },
      {
        embedding: { ...selected.embedding!, secretName: "rotated_embedding" },
      },
      { secretName: "rotated_search" },
      { requestCostMicrousd: 6_000 },
      { approvedCostMicrousd: 2_000_000 },
    ])
      assert.notEqual(
        fingerprint,
        hostedSearchFingerprint({ ...selected, ...override }),
      );
    const descriptor = hostedSearchDescriptor(selected);
    const recursivelySorted = (value: unknown): unknown =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, entry]) => [key, recursivelySorted(entry)]),
          )
        : value;
    assert.equal(
      JSON.stringify(descriptor),
      JSON.stringify(recursivelySorted(descriptor)),
    );
    const withoutModel = hostedSearchDescriptor(research());
    assert.ok("model" in withoutModel);
    assert.equal(withoutModel.model, null);
  });

  test(`${provider} research validation rejects malformed adapters, unknown versions and excess grants`, () => {
    const selected = research(true, true);
    for (const override of [
      { approvedCostMicrousd: 2_000_001 },
      { dailyCostMicrousd: 50_000_001 },
      { dailyCostMicrousd: 999_999 },
      { requestCostMicrousd: 1_000_001 },
      { policyVersion: "exa-research.v3" },
      {
        policyVersion:
          provider === "brave" ? "serper-research.v2" : "brave-research.v2",
      },
      { policyVersion: "unknown.v1" },
      { model: null },
      { model: {} },
      { model: [] },
      { model: { ...selected.model, baseUrl: "https://unreviewed.invalid" } },
      { model: { ...selected.model, reasoningEffort: "unsupported" } },
      {
        model: { ...selected.model, name: "https://unreviewed.invalid/model" },
      },
      { model: { ...selected.model, secretName: "invalid-name" } },
      { embedding: null },
      { embedding: {} },
      { embedding: [] },
      {
        embedding: {
          ...selected.embedding,
          endpoint: "https://unreviewed.invalid",
        },
      },
      { embedding: { ...selected.embedding, name: "unknown" } },
      { embedding: { ...selected.embedding, secretName: "INVALID" } },
    ])
      assert.throws(() =>
        validateHostedSearchPolicy({
          ...selected,
          ...override,
        } as HostedSearchPolicy),
      );
    for (const input of [
      { max_fetches: -1 },
      { max_model_requests: 1.5 },
      { max_input_tokens: Infinity },
      { max_cost_microusd: Number.NaN },
      { unexpected: 1 },
      JSON.parse('{"__proto__":1}'),
    ])
      assert.throws(() => hostedSearchBudgets(input, selected, 100));
    for (const deadline of [0, -1, 1.5, Number.NaN, Infinity])
      assert.throws(() => hostedSearchBudgets({}, selected, deadline));
  });

  test(`${provider} search estimate bounds search fanout independently of semantic ceilings`, () => {
    const selected = research(true, true);
    const caps = hostedSearchBudgets(
      { max_cost_microusd: 10_000 },
      selected,
      100,
    );
    assert.equal(caps.max_search_requests, 2);
    assert.equal(caps.max_search_queries, 2);
    assert.equal(caps.max_model_requests, 96);
    assert.equal(caps.max_input_tokens, 200_000);
    assert.equal(caps.max_output_tokens, 16_000);
    assert.equal(caps.max_cost_microusd, 10_000);
  });

  test(`${provider} gateway and credential-bearing Flight descriptors and fingerprints agree`, () => {
    const policies = [
      policy,
      { ...policy, policyVersion: `${provider}-search.v1` },
      research(),
      research(true),
      research(false, true),
      research(true, true),
      { ...research(true, true), approvedCostMicrousd: 2_000_000 },
    ];
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const result = spawnSync(
      process.env.SOURCESQL_TEST_PYTHON ??
        process.env.SOURCESQL_PYTHON ??
        join(root, "local/python312/venv/bin/python"),
      [
        "-B",
        "-c",
        `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("reviewed_search_policy", sys.argv[1])
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
print(json.dumps([{
    "descriptor": (settings := policy.load_configuration(environment))["descriptor"],
    "canonical": json.dumps(settings["descriptor"], sort_keys=True, separators=(",", ":")),
    "fingerprint": settings["provider_policy_sha256"],
} for environment in json.load(sys.stdin)]))
`,
        join(root, "hosted/flight/exa_profile.py"),
      ],
      {
        input: JSON.stringify(policies.map(hostedSearchConfiguration)),
        encoding: "utf8",
        timeout: 5000,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    for (const [index, selected] of policies.entries()) {
      assert.deepEqual(
        hostedSearchDescriptor(selected),
        actual[index].descriptor,
      );
      assert.equal(
        JSON.stringify(hostedSearchDescriptor(selected)),
        actual[index].canonical,
      );
      assert.equal(
        hostedSearchFingerprint(selected),
        actual[index].fingerprint,
      );
    }
  });
}

test("legacy Exa descriptors and fingerprints are unchanged", () => {
  const policy = {
    approvedCostMicrousd: 50_000,
    dailyCostMicrousd: 1_000_000,
    secretName: "sourcesql_exa",
  };
  assert.deepEqual(exaDescriptor(policy), {
    approved_cost_microusd: 50_000,
    secret_name: "sourcesql_exa",
    version: "exa-search.v1",
  });
  assert.equal(
    exaFingerprint(policy),
    "d46b097da9f7ac09575bd9916889aa2a944c3013e163b0079e98585708318004",
  );
  assert.equal(
    exaFingerprint({ ...policy, policyVersion: "exa-research.v2" }),
    "5e31ea3484b972d2f9b0c9e69ad88f226582b19234e236bc6c3dca5bf0e1e901",
  );
});
