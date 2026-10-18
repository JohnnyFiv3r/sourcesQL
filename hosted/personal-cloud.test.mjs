import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  validateConfig,
  createPlan,
  assertPlan,
  deploymentFiles,
  uploadDeploymentFiles,
  bootstrapFiles,
  applyPlan,
  environmentSettings,
  setupArguments,
  vercelAPI,
  savePrivate,
  reconcileFlight,
  ownerBearer,
  providerBindings,
  assertCapabilities,
  usageWarnings,
} from "./personal-cloud.mjs";
import { parseArguments as parseSetup, flightConfiguration } from "./setup.mjs";
import {
  exaOperators,
  exaResearchLimits,
  exaSearchTypes,
} from "../apps/research/server/hosted-exa.ts";
import {
  HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS,
  hostedSearchBudgets,
  hostedSearchOperators,
} from "../apps/research/server/hosted-search.ts";
const root = resolve(import.meta.dirname, "..");
const hash = (v) => createHash("sha256").update(v).digest("hex");
const config = () => ({
  project: "personal-research",
  account_id: "account_fixture1",
  alias: "personal-research-fixture.vercel.app",
  database: "research",
  principal: "personal-owner",
  oauth: {
    issuer: "https://login.example.org/",
    subject: "auth0|immutable-owner",
    jwks_uri: "https://login.example.org/.well-known/jwks.json",
  },
});
function workspace() {
  const path = mkdtempSync(join(tmpdir(), "sourcesql-cloud-"));
  mkdirSync(join(path, "bundle"));
  writeFileSync(join(path, "bundle/flight.py"), "# synthetic flight\n");
  writeFileSync(join(path, "bundle/requirements.txt"), "synthetic==1\n");
  writeFileSync(
    join(path, "bundle/manifest.json"),
    JSON.stringify({
      credentials_embedded: false,
      flight_source_sha256: hash("# synthetic flight\n"),
      requirements_sha256: hash("synthetic==1\n"),
    }),
  );
  return path;
}
function flightReceipt(path, plan) {
  const receipt = {
    flight_id: "11111111-2222-3333-4444-555555555555",
    database: plan.config.database,
    host: plan.config.motherduck_host,
    namespace: hash(plan.config.principal),
    flight_source_sha256: plan.flight_source_sha256,
    requirements_sha256: plan.requirements_sha256,
  };
  writeFileSync(join(path, "flight.json"), JSON.stringify(receipt));
  return receipt;
}
const setupModule = {
  parseArguments: (args) => ({ args }),
  outputSettings: () => ({
    SOURCESQL_BACKEND: "motherduck",
    SOURCESQL_ALLOW_FLIGHT_SUBMISSION: "0",
  }),
};
const env = {
  VERCEL_TOKEN: "vercel-test-secret",
  MOTHERDUCK_TOKEN: "motherduck-test-secret",
};
const researchProvider = () => ({
  name: "exa",
  secret_name: "personal_exa",
  approved_cost_microusd: 50000,
  daily_cost_microusd: 100000,
  model: {
    name: "configured-model",
    secret_name: "personal_openai",
    reasoning_effort: "low",
  },
  embedding: { name: "text-embedding-3-small", secret_name: "personal_openai" },
});

test("research opt-in advertises exact operators, processors and provider-managed usage", () => {
  const path = workspace(),
    plan = createPlan(
      { ...config(), provider: researchProvider() },
      root,
      path,
    );
  assert.deepEqual(plan.research.live_operators, [
    "WEB_SEARCH",
    "WEB_FETCH",
    "SEM_MATCH",
    "SEM_EXTRACT",
    "SEM_EXTRACT_ALL",
    "SEM_NORM",
    "SEM_SCORE",
  ]);
  assert.deepEqual(plan.research.third_party_processors, ["exa", "openai"]);
  assert.equal(plan.research.model, "configured-model");
  assert.equal(plan.research.embedding, "text-embedding-3-small");
  assert.equal(plan.limits.execution_enabled, false);
  assert.equal(plan.limits.model_calls_during_setup, 0);
  assert.equal(plan.limits.usage_mode, "provider_managed");
  assert.equal(plan.limits.provider_cost_microusd_per_job, 50000);
  assert.match(plan.research.usage_basis, /estimates/);
  assert.deepEqual(
    providerBindings(plan.config).map((entry) => entry.name),
    ["personal_exa", "personal_openai"],
  );
  const options = parseSetup(setupArguments(plan.config, path), {});
  assert.equal(options.exa.descriptor.version, "exa-research.v3");
  assert.equal(options.exa.descriptor.model.reasoning_effort, "low");
  assert.equal(
    flightConfiguration(options, "a".repeat(64), "reviewed")
      .SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME,
    "personal_openai",
  );
  assert.deepEqual(
    createPlan(config(), root, path).research.live_operators,
    [],
  );
  const embeddingOnly = researchProvider();
  delete embeddingOnly.model;
  const only = createPlan({ ...config(), provider: embeddingOnly }, root, path);
  assert.deepEqual(only.research.live_operators, [
    "WEB_SEARCH",
    "WEB_FETCH",
    "SEM_SCORE",
  ]);
  assert.equal(only.research.model, null);
});

test("semantic setup rejects fixtures, keys, partial models and conflicting shared-secret reuse", () => {
  for (const change of [
    { name: "fixture" },
    { model: { name: "configured-model" } },
    {
      model: {
        name: "configured-model",
        secret_name: "personal_openai",
        api_key: "never-in-config",
      },
    },
    { model: { name: "configured-model", secret_name: "personal_exa" } },
    { embedding: { name: "unknown", secret_name: "personal_openai" } },
    {
      embedding: {
        name: "text-embedding-3-small",
        secret_name: "personal_openai",
        reuse_secret: true,
      },
    },
  ])
    assert.throws(
      () =>
        validateConfig({
          ...config(),
          provider: { ...researchProvider(), ...change },
        }),
      /invalid_(?:provider_)?configuration/,
    );
});

test("low-grant research onboarding verifies the actual gateway's affordable search limits", () => {
  for (const name of ["brave", "serper", "deepseek"]) {
    const path = workspace();
    const plan = createPlan(
      {
        ...config(),
        provider: {
          ...researchProvider(),
          name,
          secret_name: `personal_${name}`,
          request_cost_microusd: 5000,
        },
      },
      root,
      path,
    );
    const { policy, descriptor } = parseSetup(
      setupArguments(plan.config, path),
      {},
    ).search;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        new URL(
          "../apps/research/node_modules/tsx/dist/loader.mjs",
          import.meta.url,
        ).href,
        "--input-type=module",
        "--eval",
        `
import { readFileSync } from 'node:fs';
const { MotherDuckEngine } = await import(${JSON.stringify(new URL("../apps/research/server/motherduck.ts", import.meta.url).href)});
const engine = new MotherDuckEngine({
  database: 'synthetic_test', host: 'pg.us-east-1-aws.motherduck.com',
  token: 'synthetic-no-network', principal: 'owner-a',
  flightId: '11111111-1111-4111-a111-111111111111',
  usageMode: 'provider_managed', search: JSON.parse(readFileSync(0, 'utf8')),
  clientFactory() { throw Error('capabilities must not connect'); },
});
console.log(JSON.stringify(await engine.call('capabilities')));
`,
      ],
      { input: JSON.stringify(policy), encoding: "utf8", cwd: root },
    );
    assert.equal(result.status, 0, result.stderr);
    const capabilities = JSON.parse(result.stdout);
    const live = capabilities.profiles.find((profile) => profile.name === name);
    assert.equal(live.search_limits.max_search_queries, 10);
    assert.equal(live.search_limits.max_search_requests, 10);
    assert.deepEqual(plan.research.search_limits, live.search_limits);
    assertCapabilities(plan.config, capabilities);
    // The review fingerprint binds the complete policy, independently of the
    // lower grant's effective dispatch allowance.
    assert.equal(descriptor.limits.max_search_queries, 32);
    assert.equal(descriptor.limits.max_search_requests, 48);
    assert.deepEqual(plan.research.provider_policy, descriptor);
    const rawCaps = structuredClone(capabilities);
    rawCaps.profiles.find((profile) => profile.name === name).search_limits = {
      ...descriptor.limits,
      max_cost_microusd: 50000,
    };
    assert.throws(
      () => assertCapabilities(plan.config, rawCaps),
      /hosted_capabilities_mismatch/,
    );
  }
});

for (const name of ["brave", "serper", "deepseek"]) {
  test(`${name} guided research preserves exact adapter and budget choices through plan, setup and verification`, () => {
    const path = workspace();
    for (const included of ["model", "embedding", "both"]) {
      const provider = {
        ...researchProvider(),
        name,
        secret_name: `personal_${name}`,
        request_cost_microusd: 5000,
      };
      if (included === "model") delete provider.embedding;
      if (included === "embedding") delete provider.model;
      const plan = createPlan({ ...config(), provider }, root, path);
      const options = parseSetup(setupArguments(plan.config, path), {});
      const { policy, descriptor, providerPolicySha256 } = options.search;
      assert.equal(
        descriptor.version,
        HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS[name],
      );
      assert.equal(
        descriptor.model?.name ?? null,
        provider.model?.name ?? null,
      );
      assert.deepEqual(plan.research.provider_policy, descriptor);
      assert.equal(plan.research.provider_policy_sha256, providerPolicySha256);
      assert.deepEqual(plan.research.third_party_processors, [name, "openai"]);
      assert.deepEqual(
        plan.research.live_operators,
        hostedSearchOperators(policy),
      );
      assert.ok(
        plan.research.live_operators.includes("SEM_MATCH") === !!provider.model,
      );
      assert.ok(
        plan.research.live_operators.includes("SEM_SCORE") ===
          !!provider.embedding,
      );
      assert.ok(plan.research.live_operators.includes("WEB_FETCH"));
      assert.deepEqual(
        providerBindings(plan.config).map((binding) => [
          binding.name,
          binding.keyName,
        ]),
        [
          [`personal_${name}`, name.toUpperCase() + "_API_KEY"],
          ["personal_openai", "OPENAI_API_KEY"],
        ],
      );
      const caps = {
        profiles: [
          { name: "fixture", mode: "fixture", provider: "fixture" },
          {
            name,
            mode: "live",
            provider: name,
            operators: hostedSearchOperators(policy),
            model_configured: !!provider.model,
            model_name: provider.model?.name ?? null,
            embedding_configured: !!provider.embedding,
            embedding_model: provider.embedding?.name ?? null,
            ...(provider.embedding
              ? {
                  embedding_adapter_version: "openai-embeddings.v2",
                  embedding_token_encoding: "cl100k_base",
                  score_basis: "cosine_similarity",
                }
              : {}),
            search_limits: hostedSearchBudgets({}, policy, 100),
          },
        ],
        flight_submission_enabled: false,
        max_flight_runtime_seconds: 120,
        usage_mode: "provider_managed",
        monthly_execution_reserve_seconds: null,
        monthly_provider_reserve_microusd: null,
        daily_execution_reserve_seconds: null,
      };
      assertCapabilities(plan.config, caps);
      for (const mutate of [
        (entry) => {
          entry.operators = ["WEB_SEARCH"];
        },
        (entry) => {
          entry.search_limits.max_model_requests += 1;
        },
        (entry) => {
          entry.model_name = "different";
        },
        (entry) => {
          entry.operators.push("UNPLANNED");
        },
      ]) {
        const changed = structuredClone(caps);
        mutate(changed.profiles[1]);
        assert.throws(
          () => assertCapabilities(plan.config, changed),
          /hosted_capabilities_mismatch/,
        );
      }
      for (const mutate of [
        (changed) => {
          changed.provider.approved_cost_microusd += 1;
        },
        (changed) => {
          changed.provider.secret_name += "_new";
        },
        (changed) => {
          if (changed.provider.model)
            changed.provider.model.name = "different-model";
          else changed.provider.embedding.name = "text-embedding-3-large";
        },
        (changed) => {
          if (changed.provider.model)
            changed.provider.model.secret_name += "_new";
          else changed.provider.embedding.secret_name += "_new";
        },
      ]) {
        const changed = structuredClone(plan.config);
        mutate(changed);
        assert.throws(
          () =>
            assertPlan(plan, createPlan(changed, root, path), plan.plan_sha256),
          /plan_changed_review_again/,
        );
      }
    }
  });
  test(`${name} guided semantic configuration rejects credentials, collisions and conflicting shared-secret reuse`, async () => {
    const provider = {
      ...researchProvider(),
      name,
      secret_name: `personal_${name}`,
      request_cost_microusd: 5000,
    };
    for (const change of [
      { model: { name: "configured-model" } },
      { model: { name: "configured-model", secret_name: `personal_${name}` } },
      {
        model: {
          name: "configured-model",
          secret_name: "personal_openai",
          api_key: "private",
        },
      },
      { embedding: { name: "unknown", secret_name: "personal_openai" } },
      {
        embedding: {
          name: "text-embedding-3-small",
          secret_name: "personal_openai",
          reuse_secret: true,
        },
      },
    ])
      assert.throws(
        () =>
          validateConfig({ ...config(), provider: { ...provider, ...change } }),
        /invalid_(?:provider_)?configuration/,
      );
    const plan = createPlan({ ...config(), provider }, root, workspace());
    let accessed = false;
    await assert.rejects(
      applyPlan(
        plan,
        root,
        workspace(),
        { ...env, [name.toUpperCase() + "_API_KEY"]: "private-search" },
        {},
        () => {},
        {
          api: async () => {
            accessed = true;
          },
        },
      ),
      /missing_or_invalid_model_credential/,
    );
    assert.equal(accessed, false);
    const reused = structuredClone(provider);
    reused.model.reuse_secret = true;
    reused.embedding.reuse_secret = true;
    assert.deepEqual(
      providerBindings(validateConfig({ ...config(), provider: reused })).map(
        (binding) => binding.reuse,
      ),
      [false, true],
    );
  });
}

test("verification rejects capabilities that disagree with the reviewed research adapters or limits", () => {
  const configured = validateConfig({
      ...config(),
      provider: researchProvider(),
    }),
    policy = parseSetup(setupArguments(configured, "/synthetic"), {}).exa
      .policy;
  const expected = {
    profiles: [
      { name: "fixture", mode: "fixture", provider: "fixture" },
      ...Object.entries(exaSearchTypes(policy)).map(([name, search_type]) => ({
        name,
        search_type,
        mode: "live",
        provider: "exa",
        operators: exaOperators(policy),
        model_configured: true,
        model_name: configured.provider.model.name,
        embedding_configured: true,
        embedding_model: configured.provider.embedding.name,
        embedding_adapter_version: "openai-embeddings.v2",
        embedding_token_encoding: "cl100k_base",
        score_basis: "cosine_similarity",
        search_limits: {
          ...exaResearchLimits(policy),
          max_cost_microusd: configured.provider.approved_cost_microusd,
        },
      })),
    ],
    flight_submission_enabled: false,
    max_flight_runtime_seconds: 120,
    usage_mode: "provider_managed",
    monthly_execution_reserve_seconds: null,
    monthly_provider_reserve_microusd: null,
    daily_execution_reserve_seconds: null,
  };
  assertCapabilities(configured, expected);
  for (const mutate of [
    (caps) => {
      caps.profiles[1].embedding_configured = false;
    },
    (caps) => {
      caps.profiles[1].model_name = "other-model";
    },
    (caps) => {
      caps.profiles[1].operators = ["WEB_SEARCH"];
    },
    (caps) => {
      caps.profiles[1].search_limits.max_model_requests = 1000;
    },
    (caps) => {
      caps.profiles.push({ name: "unplanned" });
    },
    (caps) => {
      caps.monthly_provider_reserve_microusd = 99999999;
    },
    (caps) => {
      caps.usage_mode = "application_reservations";
    },
    (caps) => {
      caps.daily_execution_reserve_seconds = 600;
    },
    (caps) => {
      caps.flight_submission_enabled = true;
    },
  ]) {
    const changed = structuredClone(expected);
    mutate(changed);
    assert.throws(
      () => assertCapabilities(configured, changed),
      /hosted_capabilities_mismatch/,
    );
  }
});

test("missing OpenAI credentials refuse before any cloud account access", async () => {
  const path = workspace(),
    plan = createPlan(
      { ...config(), provider: researchProvider() },
      root,
      path,
    );
  for (const key of [undefined, "has spaces", "x".repeat(4097)]) {
    let accessed = false;
    await assert.rejects(
      applyPlan(
        plan,
        root,
        path,
        { ...env, EXA_API_KEY: "private-exa", OPENAI_API_KEY: key },
        {},
        () => {},
        {
          api: async () => {
            accessed = true;
          },
        },
      ),
      /missing_or_invalid_model_credential/,
    );
    assert.equal(accessed, false);
  }
});

test("shared OpenAI secret recovers a lost creation response without keys entering Vercel or state", async () => {
  const path = workspace(),
    plan = createPlan(
      { ...config(), provider: researchProvider() },
      root,
      path,
    ),
    state = {},
    captures = [],
    secrets = new Set(),
    sqlCalls = [];
  flightReceipt(path, plan);
  let loseOpenAI = true;
  const connect = async () => ({
    query: async (sql) => {
      sqlCalls.push(sql);
      if (sql.startsWith("SELECT name,type,storage")) {
        const name = sql.match(/WHERE name='([^']+)'/)[1];
        return {
          rows: secrets.has(name)
            ? [{ name, type: "flights", storage: "motherduck" }]
            : [],
        };
      }
      const name = sql.match(/^CREATE SECRET "([^"]+)"/)[1];
      secrets.add(name);
      if (name === "personal_openai" && loseOpenAI) {
        loseOpenAI = false;
        throw Error("synthetic lost response");
      }
      return { rows: [] };
    },
    end: async () => {},
  });
  const injected = {
    api: fakeAPI(plan, captures),
    connect,
    run: () => {},
    setupModule,
  };
  await assert.rejects(
    applyPlan(
      plan,
      root,
      path,
      {
        ...env,
        EXA_API_KEY: "private-exa-key",
        OPENAI_API_KEY: "private-model-key",
      },
      state,
      () => {},
      injected,
    ),
    /synthetic lost response/,
  );
  assert.equal(state.provider_secret_ready, true);
  assert.equal(state.openai_personal_openai_secret_attempted, true);
  assert.equal(state.openai_personal_openai_secret_ready, undefined);
  await applyPlan(plan, root, path, env, state, () => {}, injected);
  assert.equal(state.openai_personal_openai_secret_ready, true);
  assert.equal(
    sqlCalls.filter((sql) => sql.startsWith('CREATE SECRET "personal_openai"'))
      .length,
    1,
  );
  assert.ok(
    !JSON.stringify({ state, captures, plan }).includes("private-model-key"),
  );
  assert.ok(!JSON.stringify(captures).includes("private-exa-key"));
});

test("research Flight recovery requires every exact secret binding", async () => {
  const path = workspace(),
    plan = createPlan(
      { ...config(), provider: researchProvider() },
      root,
      path,
    ),
    receipt = { ...flightReceipt(path, plan), flight_name: "reviewed-flight" },
    expected = { DATABASE: plan.config.database };
  let observed = ["personal_openai", "personal_exa"];
  const client = {
    query: async (sql) => ({
      rows: sql.includes("md_get_flight_version")
        ? [
            {
              instance_type: "F4",
              max_runtime_sec: 120,
              config_json: JSON.stringify(expected),
              source_hash: receipt.flight_source_sha256,
              requirements_hash: receipt.requirements_sha256,
              secrets_json: JSON.stringify(observed),
            },
          ]
        : [
            {
              name: "reviewed-flight",
              current_version: 1,
              schedule_cron: null,
            },
          ],
    }),
  };
  await reconcileFlight(
    client,
    receipt,
    receipt.flight_id,
    plan.config,
    expected,
  );
  for (const names of [
    ["personal_exa"],
    ["personal_exa", "unapproved"],
    ["personal_exa", "personal_openai", "personal_openai"],
  ]) {
    observed = names;
    await assert.rejects(
      reconcileFlight(
        client,
        receipt,
        receipt.flight_id,
        plan.config,
        expected,
      ),
      /flight_recovery_mismatch/,
    );
  }
});
function fakeAPI(
  plan,
  captures,
  { lost = false, seeded = true, productionState = "READY" } = {},
) {
  let created = false,
    deploymentMeta;
  return async (path, body) => {
    captures.push({ path, body });
    if (path === "/v2/files") return;
    if (path === "/v2/user") return { user: { id: plan.config.account_id } };
    if (path.startsWith("/v9/projects/"))
      return created
        ? {
            id: "prj_fixture",
            name: plan.config.project,
            accountId: plan.config.account_id,
            targets: seeded
              ? { production: { id: "dpl_seed", readyState: productionState } }
              : {},
          }
        : undefined;
    if (path === "/v11/projects") {
      if (Object.hasOwn(body, "nodeVersion"))
        throw Error(
          "vercel_request_failed_400_additional_property_nodeVersion",
        );
      created = true;
      return {
        id: "prj_fixture",
        name: plan.config.project,
        accountId: plan.config.account_id,
        targets: seeded
          ? { production: { id: "dpl_seed", readyState: productionState } }
          : {},
      };
    }
    if (path.includes("/env?")) return { created: [], failed: [] };
    if (path === "/v13/deployments") {
      deploymentMeta = body.meta;
      if (lost) throw Error("lost response");
      return { id: "dpl_fixture" };
    }
    if (path.startsWith("/v6/deployments"))
      return {
        deployments: [{ uid: "dpl_fixture", meta: deploymentMeta }],
      };
    if (path === "/v13/deployments/dpl_fixture")
      return {
        id: "dpl_fixture",
        projectId: "prj_fixture",
        readyState: "READY",
        target: null,
        meta: deploymentMeta,
      };
    if (path.startsWith("/v4/aliases/")) return undefined;
    if (path.endsWith("/aliases")) return { alias: plan.config.alias };
    throw Error("unexpected API route");
  };
}

function bootstrapAPI(
  plan,
  captures,
  {
    lost = false,
    readyState = "READY",
    mutate = (deployment) => deployment,
    matches = (meta) => [
      { uid: "dpl_wrong_plan", meta: { ...meta, sourcesqlBootstrap: "other" } },
      {
        uid: "dpl_wrong_attempt",
        meta: { ...meta, sourcesqlAttempt: "other" },
      },
      { uid: "dpl_bootstrap", meta },
    ],
  } = {},
) {
  const delegate = fakeAPI(plan, captures, { seeded: false });
  let metadata;
  return {
    ready: () => {
      readyState = "READY";
    },
    api: async (route, body, options) => {
      if (route === "/v13/deployments" && body.meta?.sourcesqlBootstrap) {
        captures.push({ path: route, body });
        metadata = body.meta;
        if (lost) throw Error("lost bootstrap response");
        return { id: "dpl_bootstrap" };
      }
      if (route === "/v13/deployments/dpl_bootstrap") {
        captures.push({ path: route, body });
        return mutate({
          id: "dpl_bootstrap",
          projectId: "prj_fixture",
          ownerId: plan.config.account_id,
          target: "production",
          readyState,
          meta: metadata,
        });
      }
      if (route.startsWith("/v6/deployments")) {
        captures.push({ path: route, body });
        return { deployments: matches(metadata) };
      }
      return delegate(route, body, options);
    },
  };
}
test("strict configuration rejects secrets, invalid owners, different destinations and partial OAuth", () => {
  for (const value of [
    { ...config(), EXA_API_KEY: "hidden" },
    { ...config(), team_id: "team_elsewhere" },
    { ...config(), alias: "localhost" },
    { ...config(), allow_static_bootstrap: "yes" },
    {
      ...config(),
      oauth: { ...config().oauth, jwks_uri: "https://untrusted.example/key" },
    },
  ])
    assert.throws(() => validateConfig(value));
  assert.equal(validateConfig(config()).provider.name, "fixture");
  assert.equal(
    validateConfig({ ...config(), allow_static_bootstrap: true })
      .allow_static_bootstrap,
    true,
  );
});
test("personal-cloud defaults have no accumulated reservation gates", () => {
  const normalized = validateConfig(config());
  assert.equal(normalized.monthly_flight_seconds, undefined);
  assert.equal(normalized.monthly_provider_cost_microusd, undefined);
  assert.equal(normalized.daily_flight_seconds, undefined);
  assert.deepEqual(usageWarnings(normalized), []);
  const explicit = validateConfig({
    ...config(),
    monthly_flight_seconds: 0,
    monthly_provider_cost_microusd: 0,
    daily_flight_seconds: 0,
  });
  assert.equal(explicit.monthly_flight_seconds, 0);
  assert.equal(explicit.monthly_provider_cost_microusd, 0);
  assert.equal(explicit.daily_flight_seconds, 0);
  assert.equal(usageWarnings(explicit).length, 3);
  assert.ok(
    usageWarnings(explicit).every((warning) =>
      /deprecated metadata.*no longer limits usage.*do not measure account balances/.test(
        warning,
      ),
    ),
  );
  const maximum = validateConfig({
    ...config(),
    monthly_flight_seconds: 2678400,
    monthly_provider_cost_microusd: 1000000000,
    daily_flight_seconds: 86400,
  });
  assert.equal(maximum.monthly_flight_seconds, 2678400);
  assert.equal(maximum.monthly_provider_cost_microusd, 1000000000);
  assert.equal(maximum.daily_flight_seconds, 86400);
});
test("monthly and optional daily reservation fields reject malformed or unbounded values", () => {
  for (const [field, maximum] of [
    ["monthly_flight_seconds", 2678400],
    ["monthly_provider_cost_microusd", 1000000000],
    ["daily_flight_seconds", 86400],
  ])
    for (const value of [
      -1,
      0.5,
      maximum + 1,
      Infinity,
      NaN,
      null,
      "600",
      true,
    ])
      assert.throws(
        () => validateConfig({ ...config(), [field]: value }),
        /invalid_configuration/,
        `${field}: ${value}`,
      );
});
test("provider-managed settings omit accumulated limits even from explicit legacy configurations", () => {
  const settings = {
    SOURCESQL_BACKEND: "motherduck",
    SOURCESQL_USAGE_MODE: "operator_reserved",
    SOURCESQL_FLIGHT_DAILY_SECONDS: "600",
    SOURCESQL_FLIGHT_MONTHLY_SECONDS: "18000",
    SOURCESQL_PROVIDER_MONTHLY_COST_MICROUSD: "10000000",
    SOURCESQL_EXA_DAILY_COST_MICROUSD: "1000000",
    SOURCESQL_BRAVE_DAILY_COST_MICROUSD: "1000000",
    SOURCESQL_SERPER_DAILY_COST_MICROUSD: "1000000",
    SOURCESQL_DEEPSEEK_DAILY_COST_MICROUSD: "1000000",
    SOURCESQL_FLIGHT_MAX_RUNTIME_SEC: "120",
    SOURCESQL_EXA_APPROVED_COST_MICROUSD: "50000",
  };
  const secrets = {
    MOTHERDUCK_TOKEN: "fixture-database-key",
    RESEARCH_BEARER_TOKEN: "a".repeat(40),
  };
  const monthly = environmentSettings(
    validateConfig(config()),
    settings,
    secrets,
  );
  assert.equal(monthly.SOURCESQL_BACKEND, "motherduck");
  assert.equal(monthly.SOURCESQL_USAGE_MODE, "provider_managed");
  assert.equal(monthly.SOURCESQL_FLIGHT_MAX_RUNTIME_SEC, "120");
  assert.equal(monthly.SOURCESQL_EXA_APPROVED_COST_MICROUSD, "50000");
  const capKeys = Object.keys(settings).filter((key) =>
    /DAILY|MONTHLY/.test(key),
  );
  for (const key of capKeys) assert.ok(!Object.hasOwn(monthly, key), key);
  assert.equal(settings.SOURCESQL_FLIGHT_DAILY_SECONDS, "600");
  for (const daily of [0, 600, 86400]) {
    const explicit = environmentSettings(
      validateConfig({
        ...config(),
        daily_flight_seconds: daily,
        monthly_flight_seconds: 0,
        monthly_provider_cost_microusd: 0,
      }),
      settings,
      secrets,
    );
    for (const key of capKeys) assert.ok(!Object.hasOwn(explicit, key), key);
  }
});
test("reviewed plans disclose reference estimates and bind deprecated inputs without enforcing them", () => {
  const path = workspace();
  const first = createPlan(config(), root, path);
  assertPlan(first, createPlan(config(), root, path), first.plan_sha256);
  assert.equal(first.limits.usage_mode, "provider_managed");
  assert.equal(first.limits.max_flight_runtime_seconds, 120);
  assert.deepEqual(first.limits.reference_notices.exa, {
    cost_microusd: 10000000,
    period: "UTC calendar month",
  });
  assert.deepEqual(first.limits.reference_notices.motherduck_f4, {
    runtime_seconds: 1800,
    period: "UTC day",
  });
  assert.match(
    first.limits.reference_notices.basis,
    /account plan, payment method and remaining credits are unknown/,
  );
  assert.deepEqual(first.warnings, []);
  assert.ok(!Object.hasOwn(first.limits, "flight_seconds_per_month"));
  assert.ok(!Object.hasOwn(first.limits, "provider_cost_microusd_per_month"));
  assert.ok(!Object.hasOwn(first.limits, "flight_seconds_per_day"));
  for (const fields of [
    { monthly_flight_seconds: 17999 },
    { monthly_provider_cost_microusd: 9999999 },
    { daily_flight_seconds: 600 },
  ])
    assert.throws(
      () =>
        assertPlan(
          first,
          createPlan({ ...config(), ...fields }, root, path),
          first.plan_sha256,
        ),
      /plan_changed/,
    );
  const daily = createPlan(
    { ...config(), daily_flight_seconds: 600 },
    root,
    path,
  );
  assert.deepEqual(daily.limits, first.limits);
  assert.equal(daily.warnings.length, 1);
  assert.match(
    daily.warnings[0],
    /daily_flight_seconds is deprecated metadata/,
  );
});
test("provider daily allowance metadata is optional and never emitted as an accumulated cap", () => {
  for (const name of ["exa", "brave", "serper", "deepseek"]) {
    const provider = {
      name,
      secret_name: "sourcesql_" + name,
      approved_cost_microusd: 50000,
      daily_cost_microusd: 100000,
      ...(name === "exa" ? {} : { request_cost_microusd: 6000 }),
    };
    const base = validateConfig({ ...config(), provider });
    const restricted = validateConfig({
      ...config(),
      provider,
      monthly_flight_seconds: 0,
      monthly_provider_cost_microusd: 0,
    });
    assert.deepEqual(
      setupArguments(base, "/synthetic"),
      setupArguments(restricted, "/synthetic"),
    );
    assert.deepEqual(base.provider, provider);
    const prefix = "SOURCESQL_" + name.toUpperCase();
    const settings = environmentSettings(
      base,
      { [prefix + "_DAILY_COST_MICROUSD"]: "100000" },
      {
        MOTHERDUCK_TOKEN: "fixture-key",
        RESEARCH_BEARER_TOKEN: "a".repeat(40),
      },
    );
    assert.ok(!Object.hasOwn(settings, prefix + "_DAILY_COST_MICROUSD"));
    assert.ok(
      !Object.hasOwn(settings, "SOURCESQL_PROVIDER_MONTHLY_COST_MICROUSD"),
    );
    assert.equal(usageWarnings(base).length, 1);
    const { daily_cost_microusd: _daily, ...perJobProvider } = provider;
    const withoutDaily = validateConfig({
      ...config(),
      provider: perJobProvider,
    });
    assert.deepEqual(usageWarnings(withoutDaily), []);
    const options = parseSetup(setupArguments(withoutDaily, "/synthetic"), {});
    const runtime = flightConfiguration(options, "a".repeat(64), "reviewed");
    assert.equal(runtime[prefix + "_APPROVED_COST_MICROUSD"], "50000");
    assert.ok(!Object.keys(runtime).some((key) => /DAILY|MONTHLY/.test(key)));
  }
});
test("a reviewed plan binds every public file, exact setup source, account, owner, provider and limits", () => {
  const path = workspace(),
    first = createPlan(config(), root, path);
  assertPlan(first, createPlan(config(), root, path), first.plan_sha256);
  assert.throws(
    () =>
      assertPlan(
        first,
        createPlan({ ...config(), principal: "other-owner" }, root, path),
        first.plan_sha256,
      ),
    /plan_changed/,
  );
  assert.throws(() => assertPlan(first, first, "unapproved"), /plan_changed/);
  assert.equal(first.limits.scheduled_jobs, 0);
  assert.equal(first.limits.active_jobs, 1);
  assert.equal(first.limits.execution_enabled, false);
  assert.deepEqual(first.static_bootstrap_files_sha256, {
    "index.html": hash(Buffer.from(bootstrapFiles()[0].data, "base64")),
  });
  const optedIn = createPlan(
    { ...config(), allow_static_bootstrap: true },
    root,
    path,
  );
  assert.throws(
    () => assertPlan(first, optedIn, first.plan_sha256),
    /plan_changed/,
  );
  assert.ok(
    optedIn.operations.some((operation) =>
      /static Production placeholder/.test(operation),
    ),
  );
  assert.ok(
    !first.operations.some((operation) =>
      /static Production placeholder/.test(operation),
    ),
  );
});
test("upload allowlist excludes all credentials, private files and provisioning state", () => {
  const files = deploymentFiles(root);
  assert.ok(files.some((file) => file.file === "api/index.ts"));
  assert.ok(
    files.every(
      (file) =>
        !/(?:^|\/)(?:\.env[^/]*|local|artifacts|tests|\.vercel)(?:\/|$)/.test(
          file.file,
        ),
    ),
  );
  assert.ok(files.every((file) => file.encoding === "base64"));
});
test("private state is atomically saved with owner-only access and refuses symlinks", () => {
  const path = workspace(),
    state = join(path, "state.json");
  savePrivate(state, { step: 1 });
  savePrivate(state, { step: 2 });
  assert.equal(statSync(state).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(state)).step, 2);
  symlinkSync(state, join(path, "link.json"));
  assert.throws(
    () => savePrivate(join(path, "link.json"), {}),
    /unsafe_state_path/,
  );
});
test("server credentials only enter encrypted Preview requests; persisted state stays token-free", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    captures = [],
    state = { plan_sha256: plan.plan_sha256 };
  flightReceipt(path, plan);
  const calls = fakeAPI(plan, captures);
  const result = await applyPlan(plan, root, path, env, state, () => {}, {
    api: calls,
    run: () => {},
    setupModule,
  });
  assert.equal(result.ready, true);
  const encrypted = captures.find((entry) => entry.path.includes("/env?")).body;
  assert.ok(
    encrypted.every(
      (entry) =>
        entry.type === "encrypted" &&
        JSON.stringify(entry.target) === '["preview"]',
    ),
  );
  assert.equal(
    encrypted.find((entry) => entry.key === "MOTHERDUCK_TOKEN").value,
    env.MOTHERDUCK_TOKEN,
  );
  assert.equal(
    encrypted.find((entry) => entry.key === "SOURCESQL_ALLOW_FLIGHT_SUBMISSION")
      .value,
    "0",
  );
  assert.ok(!JSON.stringify(state).includes("test-secret"));
  const deployment = captures.find(
    (entry) => entry.path === "/v13/deployments",
  ).body;
  assert.equal(deployment.projectSettings.nodeVersion, "24.x");
  const creations = captures.filter(
    (entry) => entry.path === "/v13/deployments",
  ).length;
  const resumed = await applyPlan(plan, root, path, env, state, () => {}, {
    api: calls,
    run: () => {},
    setupModule,
  });
  assert.equal(resumed.ready, true);
  assert.equal(
    captures.filter((entry) => entry.path === "/v11/projects").length,
    1,
  );
  assert.equal(
    captures.filter((entry) => entry.path === "/v13/deployments").length,
    creations,
  );
});
test("a missing or unready Production seed refuses before app provisioning", async () => {
  for (const productionState of [undefined, "ERROR", "CANCELED", "BUILDING"]) {
    const path = workspace(),
      plan = createPlan(config(), root, path),
      captures = [],
      setupCalls = [];
    const unexpectedSetup = (name) => () => {
      setupCalls.push(name);
      throw Error("unexpected setup call");
    };
    await assert.rejects(
      applyPlan(plan, root, path, env, {}, () => {}, {
        api: fakeAPI(plan, captures, {
          seeded: productionState !== undefined,
          productionState,
        }),
        run: unexpectedSetup("run"),
        connect: unexpectedSetup("connect"),
        setupModule: {
          parseArguments: unexpectedSetup("parseArguments"),
          outputSettings: unexpectedSetup("outputSettings"),
        },
      }),
      /^Error: vercel_first_deployment_requires_static_bootstrap$/,
    );
    assert.deepEqual(setupCalls, []);
    assert.ok(!captures.some((entry) => entry.path.includes("/env?")));
    assert.ok(!captures.some((entry) => entry.path === "/v13/deployments"));
  }
});
test("an opted-in static bootstrap recovers a lost response and reaches Ready before app provisioning", async () => {
  const path = workspace(),
    plan = createPlan(
      { ...config(), allow_static_bootstrap: true },
      root,
      path,
    ),
    captures = [],
    state = {},
    snapshots = [],
    setupCalls = [];
  flightReceipt(path, plan);
  const platform = bootstrapAPI(plan, captures, {
    lost: true,
    readyState: "BUILDING",
  });
  const injected = {
    api: platform.api,
    run: (command) => setupCalls.push(command),
    connect: () => {
      setupCalls.push("connect");
      throw Error("unexpected connection");
    },
    setupModule: {
      parseArguments: (...args) => {
        setupCalls.push("parseArguments");
        return setupModule.parseArguments(...args);
      },
      outputSettings: (...args) => {
        setupCalls.push("outputSettings");
        return setupModule.outputSettings(...args);
      },
    },
  };
  const apply = () =>
    applyPlan(
      plan,
      root,
      path,
      env,
      state,
      () => snapshots.push(structuredClone(state)),
      injected,
    );
  await assert.rejects(apply(), /lost bootstrap response/);
  assert.equal(state.bootstrap_attempted, true);
  assert.equal(state.bootstrap_deployment_id, undefined);
  assert.ok(
    snapshots.some(
      (saved) => saved.bootstrap_attempted && saved.bootstrap_attempt_id,
    ),
  );
  const bootstrap = captures.find(
    (entry) => entry.body?.meta?.sourcesqlBootstrap,
  ).body;
  assert.equal(bootstrap.target, "production");
  assert.equal(bootstrap.meta.sourcesqlBootstrap, plan.plan_sha256);
  assert.equal(bootstrap.meta.sourcesqlAttempt, state.bootstrap_attempt_id);
  assert.deepEqual(bootstrap.files, bootstrapFiles());
  assert.deepEqual(
    bootstrap.files.map((file) => file.file),
    ["index.html"],
  );
  const html = Buffer.from(bootstrap.files[0].data, "base64").toString("utf8");
  assert.doesNotMatch(html, /<script\b/i);
  assert.equal(bootstrap.projectSettings.installCommand, "");
  assert.equal(bootstrap.projectSettings.buildCommand, "");
  assert.equal(bootstrap.projectSettings.outputDirectory, ".");
  assert.ok(!Object.hasOwn(bootstrap, "env"));
  assert.ok(!JSON.stringify(bootstrap).includes("test-secret"));
  assert.ok(
    !JSON.stringify(bootstrap).includes(
      JSON.parse(readFileSync(join(path, "owner-secret.json"))).token,
    ),
  );
  const pending = await apply();
  assert.equal(pending.ready, false);
  assert.equal(pending.stage, "bootstrap");
  assert.equal(pending.bootstrap_deployment_id, "dpl_bootstrap");
  assert.equal(pending.bootstrap_state, "BUILDING");
  assert.deepEqual(setupCalls, []);
  assert.ok(!captures.some((entry) => entry.path.includes("/env?")));
  assert.equal(
    captures.filter((entry) => entry.path === "/v13/deployments").length,
    1,
  );
  platform.ready();
  const beforeReady = captures.length;
  const result = await apply();
  assert.equal(result.ready, true);
  assert.equal(state.bootstrap_state, "READY");
  assert.deepEqual(setupCalls, ["npm", "parseArguments", "outputSettings"]);
  const environment = captures.find((entry) => entry.path.includes("/env?"));
  assert.ok(captures.indexOf(environment) >= beforeReady);
  assert.ok(
    environment.body.every(
      (entry) =>
        entry.type === "encrypted" &&
        JSON.stringify(entry.target) === '["preview"]',
    ),
  );
  const app = captures.find((entry) => entry.body?.meta?.sourcesqlSetup).body;
  assert.ok(!Object.hasOwn(app, "target"));
  assert.ok(app.files.some((file) => file.file === "api/index.ts"));
  assert.equal((await apply()).ready, true);
  assert.equal(
    captures.filter((entry) => entry.body?.meta?.sourcesqlBootstrap).length,
    1,
  );
  assert.equal(
    captures.filter((entry) => entry.body?.meta?.sourcesqlSetup).length,
    1,
  );
  assert.ok(!JSON.stringify(state).includes("test-secret"));
});
test("bootstrap destination mismatches and failed builds stop before app provisioning", async () => {
  const cases = [
    { mutate: (deployment) => ({ ...deployment, projectId: "prj_other" }) },
    { mutate: (deployment) => ({ ...deployment, ownerId: "account_other" }) },
    { mutate: (deployment) => ({ ...deployment, target: null }) },
    {
      mutate: (deployment) => ({
        ...deployment,
        meta: { ...deployment.meta, sourcesqlBootstrap: "other" },
      }),
    },
    {
      mutate: (deployment) => ({
        ...deployment,
        meta: { ...deployment.meta, sourcesqlAttempt: "other" },
      }),
    },
    { readyState: "ERROR" },
    { readyState: "CANCELED" },
  ];
  for (const scenario of cases) {
    const path = workspace(),
      plan = createPlan(
        { ...config(), allow_static_bootstrap: true },
        root,
        path,
      ),
      captures = [],
      state = {},
      setupCalls = [];
    const { api } = bootstrapAPI(plan, captures, scenario);
    const unexpectedSetup = (name) => () => {
      setupCalls.push(name);
      throw Error("unexpected setup call");
    };
    const apply = () =>
      applyPlan(plan, root, path, env, state, () => {}, {
        api,
        run: unexpectedSetup("run"),
        connect: unexpectedSetup("connect"),
        setupModule: {
          parseArguments: unexpectedSetup("parseArguments"),
          outputSettings: unexpectedSetup("outputSettings"),
        },
      });
    const expected = scenario.readyState
      ? /bootstrap_failed_inspect_deployment/
      : /bootstrap_destination_mismatch/;
    await assert.rejects(apply(), expected);
    await assert.rejects(apply(), expected);
    assert.deepEqual(setupCalls, []);
    assert.ok(!captures.some((entry) => entry.path.includes("/env?")));
    assert.equal(
      captures.filter((entry) => entry.path === "/v13/deployments").length,
      1,
    );
  }
});
test("unknown or ambiguous lost bootstrap responses never trigger a replacement upload", async () => {
  for (const matches of [
    () => [],
    (meta) => [
      { uid: "dpl_one", meta },
      { uid: "dpl_two", meta },
    ],
  ]) {
    const path = workspace(),
      plan = createPlan(
        { ...config(), allow_static_bootstrap: true },
        root,
        path,
      ),
      captures = [],
      state = {};
    const { api } = bootstrapAPI(plan, captures, { lost: true, matches });
    const unexpectedSetup = () => {
      throw Error("unexpected setup call");
    };
    const apply = () =>
      applyPlan(plan, root, path, env, state, () => {}, {
        api,
        run: unexpectedSetup,
        connect: unexpectedSetup,
        setupModule: {
          parseArguments: unexpectedSetup,
          outputSettings: unexpectedSetup,
        },
      });
    await assert.rejects(apply(), /lost bootstrap response/);
    await assert.rejects(apply(), /bootstrap_uncertain_inspect_project/);
    assert.ok(!captures.some((entry) => entry.path.includes("/env?")));
    assert.equal(
      captures.filter((entry) => entry.path === "/v13/deployments").length,
      1,
    );
  }
});
test("a production deployment response is refused before alias assignment", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    captures = [],
    state = {};
  flightReceipt(path, plan);
  const delegate = fakeAPI(plan, captures);
  const api = async (route, body, options) => {
    const response = await delegate(route, body, options);
    return route === "/v13/deployments/dpl_fixture"
      ? { ...response, target: "production" }
      : response;
  };
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, {
      api,
      run: () => {},
      setupModule,
    }),
    /deployment_destination_mismatch/,
  );
  assert.equal(
    captures.filter((entry) => entry.path === "/v13/deployments").length,
    1,
  );
  assert.ok(!captures.some((entry) => entry.path.endsWith("/aliases")));
  assert.equal(state.alias_ready, undefined);
});
test("lost deployment response recovers exact plan metadata without duplicate POST", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    captures = [],
    state = { plan_sha256: plan.plan_sha256 };
  flightReceipt(path, plan);
  const api = fakeAPI(plan, captures, { lost: true });
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, {
      api,
      run: () => {},
      setupModule,
    }),
    /lost response/,
  );
  assert.equal(state.deployment_attempted, true);
  await applyPlan(plan, root, path, env, state, () => {}, {
    api,
    run: () => {},
    setupModule,
  });
  assert.equal(
    captures.filter((entry) => entry.path === "/v13/deployments").length,
    1,
  );
  assert.equal(state.deployment_id, "dpl_fixture");
});
test("unresolved project creation and wrong account stop before any further mutation", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    state = { project_creation_attempted: true };
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, {
      api: async (path) =>
        path === "/v2/user"
          ? { user: { id: plan.config.account_id } }
          : undefined,
    }),
    /project_creation_uncertain/,
  );
  await assert.rejects(
    applyPlan(plan, root, path, env, {}, () => {}, {
      api: async () => ({ user: { id: "wrong_account" } }),
    }),
    /vercel_account_mismatch/,
  );
});
test("a personal account with a default team requires explicit scope before any project access", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    state = {},
    requests = [],
    setupCalls = [];
  const unexpectedSetup = (name) => () => {
    setupCalls.push(name);
    throw Error("unexpected setup call");
  };
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, {
      api: async (route) => {
        requests.push(route);
        if (route === "/v2/user")
          return {
            user: {
              id: plan.config.account_id,
              billing: { plan: "hobby" },
              defaultTeamId: "team_default_pro",
            },
          };
        throw Error("unexpected project access");
      },
      run: unexpectedSetup("run"),
      connect: unexpectedSetup("connect"),
      setupModule: {
        parseArguments: unexpectedSetup("parseArguments"),
        outputSettings: unexpectedSetup("outputSettings"),
      },
    }),
    /^Error: vercel_personal_scope_requires_explicit_team$/,
  );
  assert.deepEqual(requests, ["/v2/user"]);
  assert.deepEqual(setupCalls, []);
  assert.deepEqual(state, {});
});
test("unknown or multiple deployment matches never trigger a replacement submission", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path);
  flightReceipt(path, plan);
  for (const deployments of [
    [],
    [
      {
        uid: "one",
        meta: {
          sourcesqlSetup: plan.plan_sha256,
          sourcesqlAttempt: "11111111-1111-1111-1111-111111111111",
        },
      },
      {
        uid: "two",
        meta: {
          sourcesqlSetup: plan.plan_sha256,
          sourcesqlAttempt: "11111111-1111-1111-1111-111111111111",
        },
      },
    ],
  ]) {
    const state = {
      project_id: "prj_fixture",
      dependencies_ready: true,
      environment_ready: true,
      deployment_attempted: true,
      deployment_attempt_id: "11111111-1111-1111-1111-111111111111",
    };
    const api = async (route, body) => {
      assert.equal(body, undefined);
      if (route === "/v2/user") return { user: { id: plan.config.account_id } };
      if (route.startsWith("/v9/projects"))
        return {
          id: "prj_fixture",
          name: plan.config.project,
          accountId: plan.config.account_id,
          targets: { production: { id: "dpl_seed", readyState: "READY" } },
        };
      if (route.startsWith("/v6/deployments")) return { deployments };
      throw Error(route);
    };
    await assert.rejects(
      applyPlan(plan, root, path, env, state, () => {}, { api, setupModule }),
      /deployment_uncertain/,
    );
  }
});

test("DeepSeek guided setup normalizes the published estimate and preserves a conservative override", () => {
  const rawProvider = {
    name: "deepseek",
    secret_name: "personal_deepseek",
    approved_cost_microusd: 50000,
  };
  const original = structuredClone(rawProvider);
  const configured = validateConfig({ ...config(), provider: rawProvider });
  assert.equal(configured.provider.request_cost_microusd, 750);
  assert.deepEqual(rawProvider, original);
  const path = workspace();
  const plan = createPlan({ ...config(), provider: rawProvider }, root, path);
  const options = parseSetup(setupArguments(plan.config, path), {});
  assert.equal(options.search.descriptor.version, "deepseek-search.v1");
  assert.equal(options.search.descriptor.request_cost_microusd, 750);
  assert.deepEqual(plan.research.third_party_processors, ["deepseek"]);
  assert.deepEqual(
    providerBindings(plan.config).map(({ name, keyName }) => [name, keyName]),
    [["personal_deepseek", "DEEPSEEK_API_KEY"]],
  );
  assert.ok(!Object.hasOwn(plan.limits.reference_notices, "deepseek"));
  const override = validateConfig({
    ...config(),
    provider: { ...rawProvider, request_cost_microusd: 1000 },
  });
  assert.equal(
    parseSetup(setupArguments(override, path), {}).search.descriptor
      .request_cost_microusd,
    1000,
  );
  for (const request_cost_microusd of [0, -1, 749, 1.5, 50001, "750", null])
    assert.throws(
      () =>
        validateConfig({
          ...config(),
          provider: { ...rawProvider, request_cost_microusd },
        }),
      /invalid_(?:provider_)?configuration/,
    );
});

test("Search providers bind reviewed cost policies through existing setup flags", () => {
  for (const name of ["brave", "serper", "deepseek"]) {
    const configured = validateConfig({
      ...config(),
      provider: {
        name,
        secret_name: "personal_" + name,
        approved_cost_microusd: 50000,
        daily_cost_microusd: 100000,
        request_cost_microusd: 6000,
      },
    });
    const args = setupArguments(configured, "/private/setup");
    assert.ok(args.includes("--" + name + "-request-cost-microusd"));
    assert.ok(!args.some((arg) => arg.includes("API_KEY")));
  }
});
test("provider key and arbitrary API destinations never leak through request errors", async () => {
  await assert.rejects(
    vercelAPI(config(), "test-secret", "https://evil.example/", {}),
    /untrusted_api_destination/,
  );
  await assert.rejects(
    vercelAPI(
      config(),
      "test-secret",
      "/v11/projects",
      {},
      {
        fetcher: async () => ({
          ok: false,
          status: 403,
          text: () => Promise.resolve("secret-api-body"),
        }),
      },
    ),
    (error) => error.message === "vercel_request_failed_403",
  );
  const settings = environmentSettings(
    validateConfig(config()),
    {},
    { ...env, RESEARCH_BEARER_TOKEN: "x".repeat(40) },
  );
  assert.equal(
    settings.SOURCESQL_OAUTH_AUDIENCE,
    "https://personal-research-fixture.vercel.app/mcp",
  );
});
test("Flight recovery accepts only the exact saved name, owner configuration and fingerprints", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    receipt = flightReceipt(path, plan),
    expected = { DATABASE: plan.config.database };
  receipt.flight_name = "reviewed-flight";
  delete receipt.flight_id;
  let mismatch = false;
  const client = {
    query: async (sql) => ({
      rows: sql.includes("md_get_flight_version")
        ? [
            {
              instance_type: "F4",
              max_runtime_sec: 120,
              config_json: JSON.stringify(
                mismatch ? { DATABASE: "other" } : expected,
              ),
              source_hash: receipt.flight_source_sha256,
              requirements_hash: receipt.requirements_sha256,
              secrets_json: "[]",
            },
          ]
        : [
            {
              name: "reviewed-flight",
              current_version: 1,
              schedule_cron: null,
            },
          ],
    }),
  };
  await reconcileFlight(
    client,
    receipt,
    "11111111-2222-3333-4444-555555555555",
    plan.config,
    expected,
  );
  assert.equal(receipt.recovered, true);
  mismatch = true;
  await assert.rejects(
    reconcileFlight(
      client,
      receipt,
      "11111111-2222-3333-4444-555555555555",
      plan.config,
      expected,
    ),
    /flight_recovery_mismatch/,
  );
});

test("an alias owned by another project is never reassigned", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    captures = [],
    state = {};
  flightReceipt(path, plan);
  const delegate = fakeAPI(plan, captures);
  const api = (route, body, options) =>
    route.startsWith("/v4/aliases/")
      ? Promise.resolve({ projectId: "prj_unrelated" })
      : delegate(route, body, options);
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, {
      api,
      run: () => {},
      setupModule,
    }),
    /alias_belongs_to_different_project/,
  );
  assert.ok(!captures.some((entry) => entry.path.endsWith("/aliases")));
});
test("uncertain project creation needs an explicitly observed matching project ID", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    state = { project_creation_attempted: true };
  const api = async (route) =>
    route === "/v2/user"
      ? { user: { id: plan.config.account_id } }
      : {
          id: "prj_observed",
          name: plan.config.project,
          accountId: plan.config.account_id,
        };
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, { api }),
    /project_creation_uncertain_reconcile_known_project/,
  );
});
test("provider request estimate must fit the job grant and credentials are validated before account access", async () => {
  assert.throws(
    () =>
      validateConfig({
        ...config(),
        provider: {
          name: "brave",
          secret_name: "personal_brave",
          approved_cost_microusd: 50000,
          daily_cost_microusd: 100000,
          request_cost_microusd: 60000,
        },
      }),
    /invalid_provider_configuration/,
  );
  const path = workspace();
  const plan = createPlan(
    {
      ...config(),
      provider: {
        name: "serper",
        secret_name: "personal_serper",
        approved_cost_microusd: 50000,
        daily_cost_microusd: 100000,
        request_cost_microusd: 6000,
      },
    },
    root,
    path,
  );
  for (const key of [
    undefined,
    "x".repeat(4097),
    "contains space",
    "not-ascii-é",
  ]) {
    let accessed = false;
    await assert.rejects(
      applyPlan(
        plan,
        root,
        path,
        { ...env, SERPER_API_KEY: key },
        {},
        () => {},
        {
          api: async () => {
            accessed = true;
          },
        },
      ),
      /missing_or_invalid_provider_credential/,
    );
    assert.equal(accessed, false);
  }
});

function terminalAPI(
  plan,
  state,
  { lostRetry = false, terminalState = "ERROR" } = {},
) {
  const deployments = new Map([
    [
      state.deployment_id,
      {
        id: state.deployment_id,
        projectId: state.project_id,
        readyState: terminalState,
        target: null,
        meta: {
          sourcesqlSetup: plan.plan_sha256,
          sourcesqlAttempt: state.deployment_attempt_id,
        },
      },
    ],
  ]);
  let posts = 0;
  const api = async (route, body) => {
    if (route === "/v2/files") return;
    if (route === "/v2/user") return { user: { id: plan.config.account_id } };
    if (route.startsWith("/v9/projects"))
      return {
        id: "prj_fixture",
        name: plan.config.project,
        accountId: plan.config.account_id,
        targets: { production: { id: "dpl_seed", readyState: "READY" } },
      };
    if (route === "/v13/deployments") {
      posts++;
      const deployment = {
        id: "dpl_retry",
        projectId: "prj_fixture",
        readyState: "READY",
        target: null,
        meta: body.meta,
      };
      deployments.set(deployment.id, deployment);
      if (lostRetry) throw Error("lost retry response");
      return deployment;
    }
    if (route.startsWith("/v6/deployments"))
      return { deployments: [...deployments.values()] };
    if (route.startsWith("/v13/deployments/"))
      return deployments.get(route.split("/").at(-1));
    if (route.startsWith("/v4/aliases/")) return undefined;
    if (route.endsWith("/aliases")) return { alias: plan.config.alias };
    throw Error("Unexpected terminal test route");
  };
  return { api, posts: () => posts };
}
function failedState() {
  return {
    project_id: "prj_fixture",
    dependencies_ready: true,
    environment_ready: true,
    deployment_attempted: true,
    deployment_id: "dpl_failed",
    deployment_attempt_id: "11111111-1111-1111-1111-111111111111",
  };
}
test("terminal deployments require an exact explicit retry and retain the failed receipt", async () => {
  for (const terminalState of ["ERROR", "CANCELED"]) {
    const path = workspace(),
      plan = createPlan(config(), root, path),
      state = failedState();
    flightReceipt(path, plan);
    const { api, posts } = terminalAPI(plan, state, { terminalState });
    const terminal = await applyPlan(plan, root, path, env, state, () => {}, {
      api,
      setupModule,
    });
    assert.equal(terminal.terminal, true);
    assert.equal(terminal.deployment_state, terminalState);
    assert.equal(posts(), 0);
    await assert.rejects(
      applyPlan(plan, root, path, env, state, () => {}, {
        api,
        setupModule,
        retryDeploymentId: "dpl_unrelated",
      }),
      /retry_deployment_id_mismatch/,
    );
    const ready = await applyPlan(plan, root, path, env, state, () => {}, {
      api,
      setupModule,
      retryDeploymentId: "dpl_failed",
    });
    assert.equal(ready.ready, true);
    assert.equal(posts(), 1);
    assert.deepEqual(state.deployment_history, [
      {
        deployment_id: "dpl_failed",
        attempt_id: "11111111-1111-1111-1111-111111111111",
        terminal_state: terminalState,
      },
    ]);
  }
});
test("a lost retry response recovers only its attempt and never reuses an older failed deployment", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    state = failedState();
  flightReceipt(path, plan);
  const { api, posts } = terminalAPI(plan, state, { lostRetry: true });
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, {
      api,
      setupModule,
      retryDeploymentId: "dpl_failed",
    }),
    /lost retry response/,
  );
  assert.equal(state.deployment_id, undefined);
  assert.equal(state.deployment_history.length, 1);
  const ready = await applyPlan(plan, root, path, env, state, () => {}, {
    api,
    setupModule,
  });
  assert.equal(ready.ready, true);
  assert.equal(state.deployment_id, "dpl_retry");
  assert.equal(posts(), 1);
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, {
      api,
      setupModule,
      retryDeploymentId: "dpl_failed",
    }),
    /retry_deployment_id_mismatch/,
  );
});
test("an explicit retry cannot replace a still-building deployment", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    state = failedState();
  flightReceipt(path, plan);
  const { api, posts } = terminalAPI(plan, state, {
    terminalState: "BUILDING",
  });
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, {
      api,
      setupModule,
      retryDeploymentId: "dpl_failed",
    }),
    /deployment_not_terminal_retry_refused/,
  );
  assert.equal(posts(), 0);
  assert.equal(state.deployment_id, "dpl_failed");
});

test("a failed precreation Flight connection resumes from its explicit prepared receipt", async () => {
  const { isRetryableFlightReceipt } = await import("./setup.mjs");
  const path = workspace(),
    plan = createPlan(config(), root, path),
    state = {},
    captures = [];
  const receipt = flightReceipt(path, plan);
  delete receipt.flight_id;
  Object.assign(receipt, {
    schema: "sourcesql.hosted-setup.v1",
    phase: "prepared",
    flight_creation_attempted: false,
  });
  writeFileSync(join(path, "flight.json"), JSON.stringify(receipt));
  let preparations = 0;
  const run = (command) => {
    if (command === "npm") return;
    preparations++;
    if (preparations === 1)
      throw Error("connection failed before Flight creation");
    const created = flightReceipt(path, plan);
    Object.assign(created, {
      schema: receipt.schema,
      phase: "created",
      flight_creation_attempted: true,
      flight_name: "one-reviewed-flight",
    });
    writeFileSync(join(path, "flight.json"), JSON.stringify(created));
  };
  const injected = {
    api: fakeAPI(plan, captures),
    run,
    setupModule: { ...setupModule, isRetryableFlightReceipt },
  };
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, injected),
    /connection failed/,
  );
  assert.equal(
    JSON.parse(readFileSync(join(path, "flight.json"))).phase,
    "prepared",
  );
  const ready = await applyPlan(
    plan,
    root,
    path,
    env,
    state,
    () => {},
    injected,
  );
  assert.equal(ready.ready, true);
  assert.equal(preparations, 2);
  assert.equal(
    captures.filter((entry) => entry.path === "/v13/deployments").length,
    1,
  );
});
test("a named creating or legacy Flight receipt is never treated as a precreation retry", async () => {
  const { isRetryableFlightReceipt } = await import("./setup.mjs");
  for (const phase of [undefined, "creating"]) {
    const path = workspace(),
      plan = createPlan(config(), root, path),
      state = {},
      captures = [];
    const receipt = flightReceipt(path, plan);
    delete receipt.flight_id;
    Object.assign(receipt, {
      schema: "sourcesql.hosted-setup.v1",
      ...(phase
        ? {
            phase,
            flight_creation_attempted: true,
            flight_name: "possibly-created",
          }
        : {}),
    });
    writeFileSync(join(path, "flight.json"), JSON.stringify(receipt));
    let creationCalls = 0;
    const run = (command) => {
      if (command !== "npm") creationCalls++;
    };
    await assert.rejects(
      applyPlan(plan, root, path, env, state, () => {}, {
        api: fakeAPI(plan, captures),
        run,
        setupModule: { ...setupModule, isRetryableFlightReceipt },
      }),
      /flight_creation_uncertain_reconcile_receipt/,
    );
    assert.equal(creationCalls, 0);
    assert.ok(!captures.some((entry) => entry.path.includes("/env?")));
  }
});

test("owner credential persists once and conflicting explicit credentials stop before account access", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path);
  const first = "a".repeat(40),
    different = "b".repeat(40);
  assert.equal(ownerBearer(path, { RESEARCH_BEARER_TOKEN: first }), first);
  assert.equal(ownerBearer(path, {}), first);
  assert.equal(ownerBearer(path, { RESEARCH_BEARER_TOKEN: first }), first);
  let accountAccessed = false;
  await assert.rejects(
    applyPlan(
      plan,
      root,
      path,
      { ...env, RESEARCH_BEARER_TOKEN: different },
      {},
      () => {},
      {
        api: async () => {
          accountAccessed = true;
        },
      },
    ),
    /owner_credential_conflict/,
  );
  assert.equal(accountAccessed, false);
  assert.equal(
    JSON.parse(readFileSync(join(path, "owner-secret.json"))).token,
    first,
  );
});

test("public file upload uses exact binary bytes, digest and team scope with empty success body", async () => {
  const team = "team_fixture01",
    bytes = Buffer.from("reviewed public asset\n"),
    sha = createHash("sha1").update(bytes).digest("hex");
  let calls = 0;
  const result = await vercelAPI(
    { ...config(), account_id: team, team_id: team },
    "private-vercel-token",
    "/v2/files",
    bytes,
    {
      binary: true,
      contentDigest: sha,
      fetcher: async (url, options) => {
        calls++;
        assert.equal(url.origin, "https://api.vercel.com");
        assert.equal(url.pathname, "/v2/files");
        assert.equal(url.searchParams.get("teamId"), team);
        assert.equal(options.method, "POST");
        assert.equal(
          options.headers.Authorization,
          "Bearer private-vercel-token",
        );
        assert.equal(
          options.headers["Content-Type"],
          "application/octet-stream",
        );
        assert.equal(options.headers["x-vercel-digest"], sha);
        assert.equal(options.headers["Content-Length"], String(bytes.length));
        assert.deepEqual(options.body, bytes);
        assert.equal(options.redirect, "error");
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(0),
          json: () => assert.fail("empty upload response is not JSON"),
        };
      },
    },
  );
  assert.equal(result, undefined);
  assert.equal(calls, 1);
  for (const [route, body, contentDigest] of [
    ["/v11/projects", bytes, sha],
    ["/v2/files", "text", sha],
    ["/v2/files", bytes, "0".repeat(40)],
  ])
    await assert.rejects(
      vercelAPI(config(), "secret", route, body, {
        binary: true,
        contentDigest,
        fetcher: () => assert.fail("invalid upload must not dispatch"),
      }),
      /invalid_public_upload/,
    );
});

test("digest uploads resume acknowledged files and safely repeat only an unacknowledged digest", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    state = {},
    saves = [],
    uploads = [];
  let loseSecond = true;
  const api = async (route, bytes, options) => {
    assert.equal(route, "/v2/files");
    assert.equal(options.binary, true);
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(
      options.contentDigest,
      createHash("sha1").update(bytes).digest("hex"),
    );
    uploads.push({
      sha: options.contentDigest,
      sha256: hash(bytes),
      size: bytes.length,
    });
    const persisted = saves.at(-1).public_uploads.files[options.contentDigest];
    assert.equal(persisted.attempted, true);
    assert.notEqual(persisted.uploaded, true);
    if (loseSecond && uploads.length === 2)
      throw Error("lost upload acknowledgment");
  };
  const save = () => saves.push(structuredClone(state));
  await assert.rejects(
    uploadDeploymentFiles(plan, root, state, save, api),
    /lost upload acknowledgment/,
  );
  assert.equal(state.public_uploads.files[uploads[0].sha].uploaded, true);
  assert.notEqual(state.public_uploads.files[uploads[1].sha].uploaded, true);
  const unacknowledged = uploads[1];
  loseSecond = false;
  const refs = await uploadDeploymentFiles(plan, root, state, save, api);
  assert.deepEqual(uploads[2], unacknowledged);
  assert.equal(uploads.filter((x) => x.sha === uploads[0].sha).length, 1);
  assert.ok(
    refs.every((ref) => Object.keys(ref).sort().join(",") === "file,sha,size"),
  );
  assert.equal(refs.length, Object.keys(plan.public_files_sha256).length);
  assert.ok(
    Buffer.byteLength(JSON.stringify(refs)) <
      Buffer.byteLength(JSON.stringify(deploymentFiles(root))) / 20,
  );
  const count = uploads.length;
  assert.deepEqual(
    await uploadDeploymentFiles(plan, root, state, save, api),
    refs,
  );
  assert.equal(uploads.length, count);
  assert.ok(!JSON.stringify(state).includes("private-vercel-token"));
  assert.ok(!JSON.stringify(state).includes("reviewed public asset"));
});

test("upload receipts refuse source, account, team and content identity drift before dispatch", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    state = {};
  await uploadDeploymentFiles(
    plan,
    root,
    state,
    () => {},
    async () => {},
  );
  const stop = () => assert.fail("drift must stop before upload");
  const changedSource = structuredClone(plan);
  changedSource.public_files_sha256[
    Object.keys(changedSource.public_files_sha256)[0]
  ] = "0".repeat(64);
  await assert.rejects(
    uploadDeploymentFiles(changedSource, root, state, () => {}, stop),
    /plan_changed_review_again/,
  );
  const changedAccount = structuredClone(plan);
  changedAccount.config.account_id = "another_account";
  await assert.rejects(
    uploadDeploymentFiles(changedAccount, root, state, () => {}, stop),
    /public_upload_state_mismatch/,
  );
  const changedTeam = structuredClone(plan);
  changedTeam.config.team_id = "another_team";
  await assert.rejects(
    uploadDeploymentFiles(changedTeam, root, state, () => {}, stop),
    /public_upload_state_mismatch/,
  );
  const tampered = structuredClone(state);
  Object.values(tampered.public_uploads.files)[0].sha256 = "0".repeat(64);
  await assert.rejects(
    uploadDeploymentFiles(plan, root, tampered, () => {}, stop),
    /public_upload_state_mismatch/,
  );
});

test("failed content upload leaves deployment creation untouched and resume sends compact references", async () => {
  const path = workspace(),
    plan = createPlan(config(), root, path),
    captures = [],
    state = { plan_sha256: plan.plan_sha256 };
  flightReceipt(path, plan);
  const delegate = fakeAPI(plan, captures);
  let lose = true;
  const api = async (route, body, options) => {
    if (route === "/v2/files" && lose)
      throw Error("synthetic unconfirmed upload");
    return delegate(route, body, options);
  };
  const injected = { api, run: () => {}, setupModule };
  await assert.rejects(
    applyPlan(plan, root, path, env, state, () => {}, injected),
    /unconfirmed upload/,
  );
  assert.notEqual(state.deployment_attempted, true);
  assert.equal(state.deployment_attempt_id, undefined);
  assert.ok(!captures.some((entry) => entry.path === "/v13/deployments"));
  lose = false;
  assert.equal(
    (await applyPlan(plan, root, path, env, state, () => {}, injected)).ready,
    true,
  );
  const deployment = captures.find(
    (entry) => entry.path === "/v13/deployments",
  ).body;
  assert.ok(
    deployment.files.every(
      (file) => Object.keys(file).sort().join(",") === "file,sha,size",
    ),
  );
  assert.ok(!JSON.stringify(deployment).includes('"data":'));
  assert.ok(!JSON.stringify(deployment).includes("test-secret"));
  assert.equal(
    captures.filter((entry) => entry.path === "/v13/deployments").length,
    1,
  );
});
