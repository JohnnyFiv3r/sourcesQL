import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  EXA_SEARCH_TYPES,
  exaBudgets,
  exaConfiguration,
  exaDeadline,
  exaDescriptor,
  exaFingerprint,
  exaOperators,
  exaResearchLimits,
  exaSearchTypes,
  validateExaPolicy,
  type HostedExaPolicy,
} from "../server/hosted-exa.js";

const base: HostedExaPolicy = {
  approvedCostMicrousd: 50_000,
  dailyCostMicrousd: 1_000_000,
  secretName: "sourcesql_exa",
};
const research = (model = false): HostedExaPolicy => ({
  ...base,
  policyVersion: "exa-research.v3",
  ...(model
    ? { model: { name: "gpt-4.1-mini", secretName: "sourcesql_openai" } }
    : {}),
});

test("gateway and credential-bearing Flight produce identical legacy and research descriptors", () => {
  const policies: HostedExaPolicy[] = [
    base,
    { ...base, policyVersion: "exa-search.v1" },
    { ...base, policyVersion: "exa-research.v2" },
    research(),
    research(true),
    {
      ...research(true),
      approvedCostMicrousd: 2_000_000,
      dailyCostMicrousd: 20_000_000,
    },
    {
      ...research(true),
      model: {
        name: "gpt-6-astra",
        secretName: "sourcesql_openai",
        reasoningEffort: "low",
      },
    },
  ];
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const python =
    process.env.SOURCESQL_TEST_PYTHON ??
    process.env.SOURCESQL_PYTHON ??
    join(root, "local/python312/venv/bin/python");
  const result = spawnSync(
    python,
    [
      "-B",
      "-c",
      `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("reviewed_exa_policy", sys.argv[1])
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
output = []
for environment in json.load(sys.stdin):
    settings = policy.load_configuration(environment)
    output.append({
        "descriptor": settings["descriptor"],
        "canonical": json.dumps(settings["descriptor"], sort_keys=True, separators=(",", ":")),
        "fingerprint": settings["provider_policy_sha256"],
    })
print(json.dumps(output))
`,
      join(root, "hosted/flight/exa_profile.py"),
    ],
    {
      input: JSON.stringify(policies.map(exaConfiguration)),
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
  for (const [index, policy] of policies.entries()) {
    assert.deepEqual(exaDescriptor(policy), actual[index].descriptor);
    assert.equal(
      JSON.stringify(exaDescriptor(policy)),
      actual[index].canonical,
    );
    assert.equal(exaFingerprint(policy), actual[index].fingerprint);
  }
  assert.deepEqual(
    actual.map((row: { fingerprint: string }) => row.fingerprint),
    [
      "d46b097da9f7ac09575bd9916889aa2a944c3013e163b0079e98585708318004",
      "d46b097da9f7ac09575bd9916889aa2a944c3013e163b0079e98585708318004",
      "5e31ea3484b972d2f9b0c9e69ad88f226582b19234e236bc6c3dca5bf0e1e901",
      "5b014d4b8a127650b8510316c4e91411e300fa946dec799bf273516265ec9cca",
      "ca46ec22ecfbacc945fbaed854111de7c8e40068f656e8cc0d675aca60784368",
      "a2415a6fbb03bd46204b7fc2d450ffd9fd342496374d97ade2e6cfe125eda3b8",
    ],
  );
});

for (const model of [false, true]) {
  test(`research grant ${model ? "with" : "without"} model exposes only effective bounded capabilities`, () => {
    const policy = research(model);
    const caps = exaResearchLimits(policy);
    assert.equal(caps.max_search_queries, 32);
    assert.equal(caps.max_search_requests, 48);
    assert.equal(caps.max_candidates, 2500);
    assert.equal(caps.max_fetches, 40);
    assert.equal(caps.max_semantic_documents, model ? 40 : 0);
    assert.equal(caps.max_model_requests, model ? 96 : 0);
    assert.equal(caps.max_input_tokens, model ? 200_000 : 0);
    assert.equal(caps.max_output_tokens, model ? 16_000 : 0);
    assert.deepEqual(exaSearchTypes(policy), EXA_SEARCH_TYPES);
    assert.deepEqual(exaOperators(policy), [
      "WEB_SEARCH",
      "WEB_FETCH",
      ...(model
        ? ["SEM_MATCH", "SEM_EXTRACT", "SEM_EXTRACT_ALL", "SEM_NORM"]
        : []),
    ]);
    assert.ok(!exaOperators(policy).includes("SEM_SCORE"));
    assert.equal(exaDeadline(policy, 120), 100);
    assert.equal(exaBudgets({}, policy, 82).dispatch_deadline_seconds, 82);
    for (const [key, ceiling] of Object.entries(exaBudgets({}, policy, 100)))
      assert.throws(() => exaBudgets({ [key]: ceiling + 1 }, policy, 100), key);
    assert.equal(
      exaBudgets({ max_candidates: 1800 }, policy, 100).max_candidates,
      1800,
    );
    for (const input of [
      { unknown: 1 },
      { max_candidates: -1 },
      { max_candidates: 1.5 },
      { max_candidates: Number.NaN },
      { max_candidates: Infinity },
      { max_cost_microusd: 0 },
      JSON.parse('{"__proto__": 1}'),
    ])
      assert.throws(() => exaBudgets(input, policy, 100));
    for (const deadline of [0, -1, 1.5, Number.NaN, Infinity])
      assert.throws(() => exaBudgets({}, policy, deadline));
  });
}

test("research configuration carries names and the reviewed policy, never credentials or a model URL", () => {
  const policy = research(true);
  assert.deepEqual(exaConfiguration(policy), {
    SOURCESQL_ALLOW_LIVE_EXA: "1",
    SOURCESQL_EXA_POLICY_VERSION: "exa-research.v3",
    SOURCESQL_EXA_APPROVED_COST_MICROUSD: "50000",
    SOURCESQL_EXA_SECRET_NAME: "sourcesql_exa",
    SOURCESQL_OPENAI_MODEL: "gpt-4.1-mini",
    SOURCESQL_OPENAI_SECRET_NAME: "sourcesql_openai",
  });
  assert.ok(!JSON.stringify(exaConfiguration(policy)).includes("API_KEY"));
  assert.ok(!JSON.stringify(exaDescriptor(policy)).includes("base_url"));
  assert.notEqual(
    exaFingerprint(policy),
    exaFingerprint({
      ...policy,
      model: { name: "gpt-4.1", secretName: "sourcesql_openai" },
    }),
  );
  assert.notEqual(
    exaFingerprint(policy),
    exaFingerprint({
      ...policy,
      model: { name: "gpt-4.1-mini", secretName: "other_openai" },
    }),
  );
  assert.equal(
    exaFingerprint(policy),
    exaFingerprint({ ...policy, dailyCostMicrousd: 10_000_000 }),
  );
});

test("only explicit research v3 configuration permits a daily ceiling up to fifty dollars", () => {
  for (const dailyCostMicrousd of [
    10_000_000, 12_000_000, 20_000_000, 50_000_000,
  ])
    validateExaPolicy({
      ...research(),
      approvedCostMicrousd: 1_000_000,
      dailyCostMicrousd,
    });
  for (const policy of [
    { ...base, dailyCostMicrousd: 1_000_001 },
    { ...base, policyVersion: "exa-search.v1", dailyCostMicrousd: 1_000_001 },
    { ...base, policyVersion: "exa-research.v2", dailyCostMicrousd: 1_000_001 },
    { ...research(), dailyCostMicrousd: 50_000_001 },
    {
      ...research(),
      approvedCostMicrousd: 2_000_001,
      dailyCostMicrousd: 3_000_000,
    },
    { ...research(), dailyCostMicrousd: 49_999 },
    { ...research(), approvedCostMicrousd: Number.NaN },
    { ...research(), dailyCostMicrousd: Infinity },
  ])
    assert.throws(() => validateExaPolicy(policy));
});

test("research v3 permits an explicit two-dollar job grant without changing defaults or legacy grants", () => {
  const policy = {
    ...research(true),
    approvedCostMicrousd: 2_000_000,
    dailyCostMicrousd: 20_000_000,
  };
  validateExaPolicy(policy);
  assert.equal(exaBudgets({}, policy, 100).max_cost_microusd, 2_000_000);
  assert.equal(
    exaBudgets({ max_cost_microusd: 2_000_000 }, policy, 100).max_cost_microusd,
    2_000_000,
  );
  assert.throws(() =>
    exaBudgets({ max_cost_microusd: 2_000_001 }, policy, 100),
  );
  assert.throws(() =>
    validateExaPolicy({ ...policy, approvedCostMicrousd: 2_000_001 }),
  );
  assert.equal(exaBudgets({}, research(), 100).max_cost_microusd, 50_000);
  for (const policyVersion of [undefined, "exa-search.v1", "exa-research.v2"])
    assert.throws(() =>
      validateExaPolicy({
        ...base,
        policyVersion,
        approvedCostMicrousd: 1_000_001,
      }),
    );
});

test("model configuration must be an exact validated pair on research v3", () => {
  const invalid: unknown[] = [
    null,
    "gpt-4.1-mini",
    [],
    {},
    { name: "gpt-4.1-mini" },
    { secretName: "sourcesql_openai" },
    { name: "gpt-4.1-mini", secretName: "UPPERCASE" },
    { name: "gpt-4.1-mini", secretName: "a".repeat(64) },
    { name: "https://other.example/model", secretName: "sourcesql_openai" },
    { name: "openai/gpt-4.1-mini", secretName: "sourcesql_openai" },
    { name: "gpt model", secretName: "sourcesql_openai" },
    { name: "g".repeat(129), secretName: "sourcesql_openai" },
    {
      name: "gpt-4.1-mini",
      secretName: "sourcesql_openai",
      baseUrl: "https://other.example",
    },
    { name: "gpt-4.1-mini", secretName: "sourcesql_openai", retries: 1 },
    {
      name: "gpt-4.1-mini",
      secretName: "sourcesql_openai",
      apiKey: "SYNTHETIC-KEY",
    },
  ];
  for (const model of invalid)
    assert.throws(() =>
      validateExaPolicy({ ...research(), model } as HostedExaPolicy),
    );
  for (const policyVersion of [undefined, "exa-search.v1", "exa-research.v2"])
    assert.throws(() =>
      validateExaPolicy({ ...research(true), policyVersion }),
    );
});

test("legacy profiles retain two searches and ten candidates without model or fetch access", () => {
  for (const policyVersion of [undefined, "exa-search.v1", "exa-research.v2"]) {
    const policy = { ...base, policyVersion };
    const caps = exaBudgets({}, policy, 120);
    assert.equal(caps.max_search_queries, 2);
    assert.equal(caps.max_search_requests, 2);
    assert.equal(caps.max_candidates, 10);
    assert.equal(caps.max_fetches, 0);
    assert.equal(caps.max_model_requests, 0);
    assert.equal(
      caps.dispatch_deadline_seconds,
      policyVersion === "exa-research.v2" ? 100 : 60,
    );
    assert.deepEqual(exaOperators(policy), ["WEB_SEARCH"]);
    assert.throws(() => exaBudgets({ max_candidates: 11 }, policy, 120));
    assert.throws(() => exaBudgets({ max_fetches: 1 }, policy, 120));
  }
});

test("reasoning effort is an optional explicit model setting with no global default", () => {
  const absent = research(true);
  assert.ok(
    !Object.hasOwn(
      exaConfiguration(absent),
      "SOURCESQL_OPENAI_REASONING_EFFORT",
    ),
  );
  const absentDescriptor = exaDescriptor(absent);
  assert.ok("model" in absentDescriptor && absentDescriptor.model);
  assert.ok(!Object.hasOwn(absentDescriptor.model, "reasoning_effort"));
  for (const reasoningEffort of ["low", "medium", "high", "xhigh", "max"]) {
    const policy = {
      ...research(),
      model: {
        name: "gpt-6-astra",
        secretName: "sourcesql_openai",
        reasoningEffort,
      },
    };
    validateExaPolicy(policy);
    assert.equal(
      exaConfiguration(policy).SOURCESQL_OPENAI_REASONING_EFFORT,
      reasoningEffort,
    );
    const descriptor = exaDescriptor(policy);
    assert.ok("model" in descriptor && descriptor.model);
    assert.equal(descriptor.model.reasoning_effort, reasoningEffort);
    assert.notEqual(exaFingerprint(policy), exaFingerprint(absent));
  }
  for (const reasoningEffort of [
    "",
    "none",
    "minimal",
    "LOW",
    "ultra",
    "auto",
    null,
    1,
  ])
    assert.throws(() =>
      validateExaPolicy({
        ...research(),
        model: {
          name: "gpt-6-astra",
          secretName: "sourcesql_openai",
          reasoningEffort,
        },
      } as HostedExaPolicy),
    );
  for (const policyVersion of [undefined, "exa-search.v1", "exa-research.v2"])
    assert.throws(() =>
      validateExaPolicy({
        ...research(),
        policyVersion,
        model: {
          name: "gpt-6-astra",
          secretName: "sourcesql_openai",
          reasoningEffort: "low",
        },
      }),
    );
  assert.throws(() =>
    validateExaPolicy({
      ...research(),
      model: {
        reasoningEffort: "low",
      },
    } as HostedExaPolicy),
  );
});
