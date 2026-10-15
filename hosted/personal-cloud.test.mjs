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
import {
  validateConfig,
  createPlan,
  assertPlan,
  deploymentFiles,
  bootstrapFiles,
  applyPlan,
  environmentSettings,
  setupArguments,
  vercelAPI,
  savePrivate,
  reconcileFlight,
  ownerBearer,
} from "./personal-cloud.mjs";
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
function fakeAPI(
  plan,
  captures,
  { lost = false, seeded = true, productionState = "READY" } = {},
) {
  let created = false,
    deploymentMeta;
  return async (path, body) => {
    captures.push({ path, body });
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
test("Brave and Serper bind explicit cost policies through existing setup flags", () => {
  for (const name of ["brave", "serper"]) {
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
