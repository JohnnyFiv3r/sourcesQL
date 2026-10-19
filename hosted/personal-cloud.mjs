/** Personal accounts only. Plan first, then apply that exact reviewed plan. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  lstatSync,
  renameSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  exaOperators,
  exaDescriptor,
  exaFingerprint,
  exaResearchLimits,
  exaSearchTypes,
  validateExaPolicy,
} from "../apps/research/server/hosted-exa.ts";
import {
  DEEPSEEK_REQUEST_COST_MICROUSD,
  HOSTED_SEARCH_POLICY_VERSIONS,
  HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS,
  hostedSearchDescriptor,
  hostedSearchFingerprint,
  hostedSearchBudgets,
  hostedSearchOperators,
  validateHostedSearchPolicy,
} from "../apps/research/server/hosted-search.ts";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
const fail = (code) => {
  throw Object.assign(new Error(code), { safe: true });
};

function exaPolicy(provider) {
  return {
    approvedCostMicrousd: provider.approved_cost_microusd,
    dailyCostMicrousd:
      provider.daily_cost_microusd ?? provider.approved_cost_microusd,
    secretName: provider.secret_name,
    policyVersion:
      provider.model || provider.embedding
        ? "exa-research.v3"
        : "exa-research.v2",
    ...(provider.model
      ? {
          model: {
            name: provider.model.name,
            secretName: provider.model.secret_name,
            ...(provider.model.reasoning_effort !== undefined
              ? { reasoningEffort: provider.model.reasoning_effort }
              : {}),
          },
        }
      : {}),
    ...(provider.embedding
      ? {
          embedding: {
            name: provider.embedding.name,
            secretName: provider.embedding.secret_name,
          },
        }
      : {}),
  };
}

function searchPolicy(provider) {
  return {
    ...exaPolicy(provider),
    provider: provider.name,
    requestCostMicrousd: provider.request_cost_microusd,
    policyVersion: (provider.model || provider.embedding
      ? HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS
      : HOSTED_SEARCH_POLICY_VERSIONS)[provider.name],
  };
}

function researchPolicy(provider) {
  if (provider.name === "fixture") return null;
  return provider.name === "exa"
    ? {
        descriptor: exaDescriptor(exaPolicy(provider)),
        fingerprint: exaFingerprint(exaPolicy(provider)),
        operators: exaOperators(exaPolicy(provider)),
        limits: exaResearchLimits(exaPolicy(provider)),
      }
    : {
        descriptor: hostedSearchDescriptor(searchPolicy(provider)),
        fingerprint: hostedSearchFingerprint(searchPolicy(provider)),
        operators: hostedSearchOperators(searchPolicy(provider)),
        limits: hostedSearchBudgets({}, searchPolicy(provider), 100),
      };
}

export function providerBindings(config) {
  const provider = config.provider;
  if (provider.name === "fixture") return [];
  const bindings = [
    {
      name: provider.secret_name,
      keyName: provider.name.toUpperCase() + "_API_KEY",
      reuse: provider.reuse_secret === true,
      statePrefix: "provider",
    },
  ];
  for (const adapter of [provider.model, provider.embedding].filter(Boolean)) {
    if (bindings.some((binding) => binding.name === adapter.secret_name))
      continue;
    bindings.push({
      name: adapter.secret_name,
      keyName: "OPENAI_API_KEY",
      reuse: adapter.reuse_secret === true,
      statePrefix: "openai_" + adapter.secret_name,
    });
  }
  return bindings;
}

export function assertCapabilities(config, capabilities) {
  const provider = config.provider,
    research = researchPolicy(provider),
    profiles = capabilities?.profiles,
    liveNames =
      provider.name === "fixture"
        ? []
        : provider.name === "exa"
          ? Object.keys(exaSearchTypes(exaPolicy(provider)))
          : [provider.name];
  if (
    !Array.isArray(profiles) ||
    JSON.stringify(profiles.map((entry) => entry.name).sort()) !==
      JSON.stringify(["fixture", ...liveNames].sort()) ||
    capabilities.flight_submission_enabled !==
      (config.enable_execution === true) ||
    capabilities.max_flight_runtime_seconds !== 120 ||
    capabilities.usage_mode !== "provider_managed" ||
    capabilities.monthly_execution_reserve_seconds !== null ||
    capabilities.monthly_provider_reserve_microusd !== null ||
    capabilities.daily_execution_reserve_seconds !== null
  )
    fail("hosted_capabilities_mismatch");
  for (const name of liveNames) {
    const entry = profiles.find((profile) => profile.name === name),
      operators = research.operators;
    if (
      entry.mode !== "live" ||
      entry.provider !== provider.name ||
      !Array.isArray(entry.operators) ||
      JSON.stringify([...entry.operators].sort()) !==
        JSON.stringify([...operators].sort()) ||
      entry.model_configured !== !!provider.model ||
      (entry.model_name ?? null) !== (provider.model?.name ?? null) ||
      entry.embedding_configured !== !!provider.embedding ||
      (entry.embedding_model ?? null) !== (provider.embedding?.name ?? null) ||
      (provider.embedding &&
        (entry.embedding_adapter_version !== "openai-embeddings.v2" ||
          entry.embedding_token_encoding !== "cl100k_base" ||
          entry.score_basis !== "cosine_similarity")) ||
      entry.search_limits?.max_cost_microusd !==
        provider.approved_cost_microusd ||
      Object.entries(research.limits).some(
        ([key, value]) => entry.search_limits?.[key] !== value,
      ) ||
      (provider.name === "exa" &&
        entry.search_type !== exaSearchTypes(exaPolicy(provider))[name])
    )
      fail("hosted_capabilities_mismatch");
  }
}
const safeIdentifier = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
export function savePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    fail("unsafe_state_path");
  const temporary = path + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
}
const strictKeys = (object, keys) => {
  if (
    !object ||
    typeof object !== "object" ||
    Array.isArray(object) ||
    Object.keys(object).some((key) => !keys.includes(key))
  )
    fail("invalid_configuration");
};
export function validateConfig(config) {
  strictKeys(config, [
    "project",
    "account_id",
    "team_id",
    "alias",
    "database",
    "principal",
    "motherduck_host",
    "oauth",
    "provider",
    "create_database",
    "adopt_existing_project",
    "allow_static_bootstrap",
    "monthly_flight_seconds",
    "monthly_provider_cost_microusd",
    "daily_flight_seconds",
    "enable_execution",
  ]);
  if (
    !/^[a-z][a-z0-9-]{1,59}$/.test(config.project ?? "") ||
    !/^[A-Za-z0-9_]{8,100}$/.test(config.account_id ?? "") ||
    (config.team_id && config.team_id !== config.account_id) ||
    !/^[a-z0-9][a-z0-9-]{1,61}\.vercel\.app$/.test(config.alias ?? "") ||
    !safeIdentifier.test(config.database ?? "") ||
    !/^[A-Za-z0-9._@:-]{1,200}$/.test(config.principal ?? "")
  )
    fail("invalid_configuration");
  const host = config.motherduck_host ?? "pg.us-east-1-aws.motherduck.com";
  if (
    ![
      "pg.us-east-1-aws.motherduck.com",
      "pg.eu-central-1-aws.motherduck.com",
    ].includes(host)
  )
    fail("invalid_configuration");
  for (const key of [
    "create_database",
    "adopt_existing_project",
    "allow_static_bootstrap",
    "enable_execution",
  ])
    if (config[key] !== undefined && typeof config[key] !== "boolean")
      fail("invalid_configuration");
  for (const [value, maximum] of [
    [config.monthly_flight_seconds, 2678400],
    [config.monthly_provider_cost_microusd, 1000000000],
  ])
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    )
      fail("invalid_configuration");
  const seconds = config.daily_flight_seconds;
  if (
    seconds !== undefined &&
    (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86400)
  )
    fail("invalid_configuration");
  const oauth = config.oauth;
  strictKeys(oauth, ["issuer", "subject", "jwks_uri"]);
  try {
    const issuer = new URL(oauth.issuer),
      jwks = new URL(oauth.jwks_uri);
    if (
      issuer.protocol !== "https:" ||
      issuer.username ||
      issuer.password ||
      issuer.port ||
      issuer.origin + "/" !== issuer.href ||
      issuer.hostname.split(".").length < 2 ||
      /(?:^|\.)(?:localhost|local|internal|home)$/.test(issuer.hostname) ||
      jwks.origin !== issuer.origin ||
      jwks.pathname === "/" ||
      jwks.search ||
      jwks.hash ||
      jwks.username ||
      jwks.password ||
      !oauth.subject ||
      oauth.subject.length > 512 ||
      oauth.subject.trim() !== oauth.subject ||
      /[\u0000-\u001f\u007f]/.test(oauth.subject)
    )
      fail("invalid_oauth_configuration");
  } catch {
    fail("invalid_oauth_configuration");
  }
  const configuredProvider = config.provider ?? { name: "fixture" };
  const provider =
    configuredProvider.name === "deepseek"
      ? {
          request_cost_microusd: DEEPSEEK_REQUEST_COST_MICROUSD,
          ...configuredProvider,
        }
      : configuredProvider;
  strictKeys(provider, [
    "name",
    "secret_name",
    "approved_cost_microusd",
    "daily_cost_microusd",
    "request_cost_microusd",
    "reuse_secret",
    "model",
    "embedding",
  ]);
  if (
    !["fixture", "exa", "brave", "serper", "deepseek"].includes(provider.name)
  )
    fail("invalid_provider_configuration");
  if (provider.name === "fixture" && Object.keys(provider).length !== 1)
    fail("invalid_provider_configuration");
  if (provider.name !== "fixture") {
    for (const [kind, adapter] of [
      ["model", provider.model],
      ["embedding", provider.embedding],
    ]) {
      if (adapter === undefined) continue;
      strictKeys(adapter, [
        "name",
        "secret_name",
        "reuse_secret",
        ...(kind === "model" ? ["reasoning_effort"] : []),
      ]);
      if (
        !/^[a-z][a-z0-9_]{0,62}$/.test(adapter.secret_name ?? "") ||
        adapter.secret_name === provider.secret_name ||
        (adapter.reuse_secret !== undefined &&
          typeof adapter.reuse_secret !== "boolean")
      )
        fail("invalid_provider_configuration");
    }
    if (
      provider.model &&
      provider.embedding &&
      provider.model.secret_name === provider.embedding.secret_name &&
      (provider.model.reuse_secret === true) !==
        (provider.embedding.reuse_secret === true)
    )
      fail("invalid_provider_configuration");
    if (
      !/^[a-z][a-z0-9_]{0,62}$/.test(provider.secret_name ?? "") ||
      (provider.reuse_secret !== undefined &&
        typeof provider.reuse_secret !== "boolean")
    )
      fail("invalid_provider_configuration");
    if (provider.name === "exa") {
      try {
        validateExaPolicy(exaPolicy(provider));
      } catch {
        fail("invalid_provider_configuration");
      }
    } else {
      try {
        validateHostedSearchPolicy(searchPolicy(provider));
      } catch {
        fail("invalid_provider_configuration");
      }
    }
    for (const key of ["approved_cost_microusd", "daily_cost_microusd"])
      if (
        (key === "approved_cost_microusd" || provider[key] !== undefined) &&
        (!Number.isSafeInteger(provider[key]) ||
          provider[key] < 1 ||
          provider[key] >
            (provider.model || provider.embedding
              ? key === "daily_cost_microusd"
                ? 50000000
                : 2000000
              : 1000000))
      )
        fail("invalid_provider_configuration");
    if (
      provider.daily_cost_microusd !== undefined &&
      provider.daily_cost_microusd < provider.approved_cost_microusd
    )
      fail("invalid_provider_configuration");
    if (
      ["brave", "serper", "deepseek"].includes(provider.name) &&
      (!Number.isSafeInteger(provider.request_cost_microusd) ||
        provider.request_cost_microusd < 1 ||
        provider.request_cost_microusd > provider.approved_cost_microusd ||
        provider.request_cost_microusd > 1000000)
    )
      fail("invalid_provider_configuration");
  }
  return {
    ...config,
    motherduck_host: host,
    provider,
  };
}

export function usageWarnings(config) {
  const fields = [
    "monthly_flight_seconds",
    "monthly_provider_cost_microusd",
    "daily_flight_seconds",
  ].filter((key) => config[key] !== undefined);
  if (config.provider?.daily_cost_microusd !== undefined)
    fields.push("provider.daily_cost_microusd");
  return fields.map(
    (field) =>
      `${field} is deprecated metadata and no longer limits usage. Provider-managed billing controls availability; sourcesQL usage estimates do not measure account balances or free credits.`,
  );
}

/** A first Vercel deployment is Production; never upload the app into that slot. */
export function bootstrapFiles() {
  return [
    {
      file: "index.html",
      data: Buffer.from(
        '<!doctype html><meta charset="utf-8"><title>sourcesQL</title><p>Research is served by the configured Preview endpoint.</p>\n',
      ).toString("base64"),
      encoding: "base64",
    },
  ];
}

async function ensurePreviewPrerequisite(plan, project, state, save, api) {
  if (
    !state.bootstrap_attempted &&
    project.targets?.production?.id &&
    project.targets.production.readyState === "READY"
  )
    return { ready: true };
  if (!plan.config.allow_static_bootstrap)
    fail("vercel_first_deployment_requires_static_bootstrap");
  if (!state.bootstrap_deployment_id) {
    if (state.bootstrap_attempted) {
      const found = await api(
        `/v6/deployments?projectId=${state.project_id}&limit=100`,
      );
      if (!uuid.test(state.bootstrap_attempt_id ?? ""))
        fail("bootstrap_uncertain_inspect_project");
      const matches = found.deployments.filter(
        (entry) =>
          entry.meta?.sourcesqlBootstrap === plan.plan_sha256 &&
          entry.meta?.sourcesqlAttempt === state.bootstrap_attempt_id,
      );
      if (matches.length !== 1) fail("bootstrap_uncertain_inspect_project");
      state.bootstrap_deployment_id = matches[0].uid ?? matches[0].id;
      save();
    } else {
      state.bootstrap_attempt_id = randomUUID();
      state.bootstrap_attempted = true;
      save();
      const created = await api("/v13/deployments", {
        name: plan.config.project,
        project: state.project_id,
        target: "production",
        files: bootstrapFiles(),
        meta: {
          sourcesqlBootstrap: plan.plan_sha256,
          sourcesqlAttempt: state.bootstrap_attempt_id,
        },
        projectSettings: {
          framework: null,
          nodeVersion: "24.x",
          installCommand: "",
          buildCommand: "",
          outputDirectory: ".",
        },
      });
      state.bootstrap_deployment_id = created.id;
      save();
    }
  }
  const deployment = await api(
    `/v13/deployments/${state.bootstrap_deployment_id}`,
  );
  if (
    deployment.target !== "production" ||
    deployment.projectId !== state.project_id ||
    (deployment.ownerId && deployment.ownerId !== plan.config.account_id) ||
    deployment.meta?.sourcesqlBootstrap !== plan.plan_sha256 ||
    deployment.meta?.sourcesqlAttempt !== state.bootstrap_attempt_id
  )
    fail("bootstrap_destination_mismatch");
  state.bootstrap_state = deployment.readyState;
  save();
  if (["ERROR", "CANCELED"].includes(deployment.readyState))
    fail("bootstrap_failed_inspect_deployment");
  return {
    ready: deployment.readyState === "READY",
    stage: "bootstrap",
    bootstrap_deployment_id: state.bootstrap_deployment_id,
    bootstrap_state: deployment.readyState,
  };
}

/** Fixed public input lanes plus explicitly named historical bundles only. */
export function deploymentFiles(root) {
  const app = join(root, "apps/research"),
    files = [];
  const fixed = new Set([
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vercel.json",
    ".vercelignore",
    "index.html",
    "research.html",
    "scripts/build.ts",
    "scripts/build-vercel.ts",
    "scripts/inline-html.ts",
    "fixtures/water-procurement.json",
  ]);
  for (const line of readFileSync(join(app, ".vercelignore"), "utf8").split(
    "\n",
  ))
    if (/^!ui-history\/research-[a-f0-9]{16}\.html$/.test(line))
      fixed.add(line.slice(1));
  const walk = (directory, relative = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = relative ? relative + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink()) {
        if (fixed.has(path) || /^(api|server|src)\//.test(path))
          fail("symlink_in_public_inputs");
        continue;
      }
      if (entry.isDirectory()) {
        if (
          [
            "api",
            "server",
            "src",
            "scripts",
            "fixtures",
            "ui-history",
            "src/brand",
            "src/fonts",
          ].includes(path)
        )
          walk(join(directory, entry.name), path);
        continue;
      }
      if (
        fixed.has(path) ||
        /^(api|server)\/[^/]+\.ts$/.test(path) ||
        /^src\/[^/]+\.(ts|tsx|css)$/.test(path) ||
        /^src\/brand\/[^/]+\.png$/.test(path) ||
        /^src\/fonts\/[^/]+(?:\.woff2|LICENSE\.txt)$/.test(path) ||
        path === "src/fonts/README.md"
      )
        files.push({
          file: path,
          data: readFileSync(join(app, path)).toString("base64"),
          encoding: "base64",
        });
    }
  };
  walk(app);
  for (const path of fixed)
    if (!files.some((file) => file.file === path)) fail("missing_public_input");
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
export async function uploadDeploymentFiles(plan, root, state, save, api) {
  const files = deploymentFiles(root).map((file) => {
    const bytes = Buffer.from(file.data, "base64");
    const sha256 = digest(bytes);
    if (plan.public_files_sha256[file.file] !== sha256)
      fail("plan_changed_review_again");
    return {
      file: file.file,
      sha: createHash("sha1").update(bytes).digest("hex"),
      size: bytes.length,
      sha256,
      bytes,
    };
  });
  if (files.length !== Object.keys(plan.public_files_sha256).length)
    fail("plan_changed_review_again");
  const manifest = files.map(({ file, sha, size, sha256 }) => ({
    file,
    sha,
    size,
    sha256,
  }));
  const manifestSha256 = digest(JSON.stringify(manifest));
  const scope = {
    account_id: plan.config.account_id,
    team_id: plan.config.team_id ?? null,
    manifest_sha256: manifestSha256,
  };
  if (
    state.public_uploads &&
    Object.entries(scope).some(
      ([key, value]) => state.public_uploads[key] !== value,
    )
  )
    fail("public_upload_state_mismatch");
  state.public_uploads ??= { ...scope, files: {} };
  // SHA-1 is the Vercel wire identifier; SHA-256 remains the plan's authority.
  const identities = new Map();
  for (const file of files) {
    if (identities.has(file.sha) && identities.get(file.sha) !== file.sha256)
      fail("public_upload_digest_collision");
    identities.set(file.sha, file.sha256);
  }
  for (const file of files) {
    const prior = state.public_uploads.files[file.sha];
    if (prior && (prior.sha256 !== file.sha256 || prior.size !== file.size))
      fail("public_upload_state_mismatch");
    if (prior?.uploaded === true) continue;
    state.public_uploads.files[file.sha] = {
      sha256: file.sha256,
      size: file.size,
      attempted: true,
    };
    save();
    // Repeating the same content digest after a lost upload acknowledgment is safe;
    // deployment creation still uses its separate, non-repeatable attempt barrier.
    await api("/v2/files", file.bytes, {
      binary: true,
      contentDigest: file.sha,
    });
    state.public_uploads.files[file.sha].uploaded = true;
    save();
  }
  return files.map(({ file, sha, size }) => ({ file, sha, size }));
}

export function createPlan(config, root, workspace) {
  config = validateConfig(config);
  const research = researchPolicy(config.provider);
  const manifest = readJSON(join(workspace, "bundle/manifest.json"));
  if (
    digest(readFileSync(join(workspace, "bundle/flight.py"))) !==
      manifest.flight_source_sha256 ||
    digest(readFileSync(join(workspace, "bundle/requirements.txt"))) !==
      manifest.requirements_sha256 ||
    manifest.credentials_embedded !== false
  )
    fail("bundle_integrity");
  const files = deploymentFiles(root);
  const plan = {
    schema: "sourcesql.personal-cloud-plan.v1",
    config,
    public_files_sha256: Object.fromEntries(
      files.map((file) => [
        file.file,
        digest(Buffer.from(file.data, "base64")),
      ]),
    ),
    static_bootstrap_files_sha256: Object.fromEntries(
      bootstrapFiles().map((file) => [
        file.file,
        digest(Buffer.from(file.data, "base64")),
      ]),
    ),
    setup_sha256: digest(readFileSync(join(root, "hosted/setup.mjs"))),
    orchestrator_sha256: digest(
      readFileSync(join(root, "hosted/personal-cloud.mjs")),
    ),
    flight_source_sha256: manifest.flight_source_sha256,
    requirements_sha256: manifest.requirements_sha256,
    operations: [
      "check Vercel account identity",
      "create or recover the named project",
      ...(config.allow_static_bootstrap
        ? [
            "create or recover a credential-free static Production placeholder if needed before uploading the app",
          ]
        : []),
      ...providerBindings(config).map(
        (binding) =>
          `bind ${binding.keyName.replace("_API_KEY", "").toLowerCase()} Flight secret ${binding.name} (no provider requests)`,
      ),
      "create or recover one unscheduled F4/120-second Flight",
      "encrypt Preview-only owner/database settings",
      "upload reviewed public inputs to one Preview",
      "assign the exact stable alias after Ready",
    ],
    limits: {
      plan_default: "Hobby for eligible personal use; never upgrades accounts",
      usage_mode: "provider_managed",
      max_flight_runtime_seconds: 120,
      ...(config.provider.name === "fixture"
        ? {}
        : {
            provider_cost_microusd_per_job:
              config.provider.approved_cost_microusd,
          }),
      reference_notices: {
        exa: { cost_microusd: 10000000, period: "UTC calendar month" },
        motherduck_f4: { runtime_seconds: 1800, period: "UTC day" },
        basis:
          "Estimated sourcesQL usage; account plan, payment method and remaining credits are unknown",
      },
      scheduled_jobs: 0,
      active_jobs: 1,
      queued_jobs: "explicit resume",
      live_search_calls_during_setup: 0,
      model_calls_during_setup: 0,
      execution_enabled: config.enable_execution === true,
    },
    research: {
      live_operators: research?.operators ?? [],
      provider_policy: research?.descriptor ?? null,
      provider_policy_sha256: research?.fingerprint ?? null,
      search_limits: research
        ? {
            ...research.limits,
            max_cost_microusd: config.provider.approved_cost_microusd,
          }
        : null,
      model: config.provider.model?.name ?? null,
      embedding: config.provider.embedding?.name ?? null,
      third_party_processors:
        config.provider.name === "fixture"
          ? []
          : [
              config.provider.name,
              ...(config.provider.model || config.provider.embedding
                ? ["openai"]
                : []),
            ],
      usage_basis:
        "Operation estimates and observed runtime; provider account totals, credits, payment methods and final bills are not measured",
    },
    warnings: usageWarnings(config),
    manual_steps: [
      "Create accounts and configure OAuth API/PKCE client; no signup or paid feature is automated",
      "Grant sourcesql:access to the intended client, with the sole owner subject above",
      "Review only the exact alias for a Deployment Protection exception before connecting hosted clients",
      "Run verify with --run-fixture deliberately to exercise Python; ordinary verification does not launch a Flight",
    ],
  };
  return { ...plan, plan_sha256: digest(JSON.stringify(plan)) };
}
export function assertPlan(saved, current, approved) {
  if (
    saved.plan_sha256 !== approved ||
    saved.plan_sha256 !== current.plan_sha256 ||
    JSON.stringify(saved) !== JSON.stringify(current)
  )
    fail("plan_changed_review_again");
}
export function environmentSettings(config, settings, secrets) {
  if (
    !secrets.MOTHERDUCK_TOKEN ||
    !secrets.RESEARCH_BEARER_TOKEN ||
    secrets.RESEARCH_BEARER_TOKEN.length < 32
  )
    fail("missing_credentials");
  // Keep per-job bounds and identity settings; accumulated reservations are
  // deprecated metadata, never a provider balance or an availability gate.
  const accumulatedCapSettings = new Set([
    "SOURCESQL_FLIGHT_DAILY_SECONDS",
    "SOURCESQL_FLIGHT_MONTHLY_SECONDS",
    "SOURCESQL_PROVIDER_MONTHLY_COST_MICROUSD",
    ...["EXA", "BRAVE", "SERPER", "DEEPSEEK"].map(
      (provider) => `SOURCESQL_${provider}_DAILY_COST_MICROUSD`,
    ),
  ]);
  const baseSettings = Object.fromEntries(
    Object.entries(settings).filter(
      ([key]) => !accumulatedCapSettings.has(key),
    ),
  );
  return {
    ...baseSettings,
    SOURCESQL_USAGE_MODE: "provider_managed",
    SOURCESQL_ALLOW_FLIGHT_SUBMISSION: config.enable_execution ? "1" : "0",
    RESEARCH_AUTH_MODE: "protected",
    RESEARCH_PUBLIC_ORIGIN: "https://" + config.alias,
    RESEARCH_BEARER_TOKEN: secrets.RESEARCH_BEARER_TOKEN,
    MOTHERDUCK_TOKEN: secrets.MOTHERDUCK_TOKEN,
    SOURCESQL_OAUTH_ISSUER: config.oauth.issuer,
    SOURCESQL_OAUTH_AUDIENCE: "https://" + config.alias + "/mcp",
    SOURCESQL_OAUTH_SUBJECT: config.oauth.subject,
    SOURCESQL_OAUTH_JWKS_URI: config.oauth.jwks_uri,
  };
}
export async function vercelAPI(
  config,
  token,
  path,
  body,
  { fetcher = fetch, allow404 = false, binary = false, contentDigest } = {},
) {
  if (
    binary &&
    (path !== "/v2/files" ||
      !Buffer.isBuffer(body) ||
      contentDigest !== createHash("sha1").update(body).digest("hex"))
  )
    fail("invalid_public_upload");
  const url = new URL(path, "https://api.vercel.com");
  if (url.origin !== "https://api.vercel.com")
    fail("untrusted_api_destination");
  if (config.team_id) url.searchParams.set("teamId", config.team_id);
  const response = await fetcher(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": binary ? "application/octet-stream" : "application/json",
      ...(binary
        ? {
            "x-vercel-digest": contentDigest,
            "Content-Length": String(body.length),
          }
        : {}),
    },
    ...(body === undefined
      ? {}
      : { body: binary ? body : JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (allow404 && response.status === 404) return undefined;
  if (!response.ok) fail("vercel_request_failed_" + response.status);
  // Successful file uploads have an empty body; they are not JSON responses.
  if (binary) {
    await response.arrayBuffer();
    return;
  }
  return response.json(); // Never log this response; env mutation responses can include values.
}
export function setupArguments(config, workspace) {
  const args = [
    "--database",
    config.database,
    "--principal",
    config.principal,
    "--bundle",
    join(workspace, "bundle"),
    "--output",
    join(workspace, "flight.json"),
  ];
  if (config.create_database) args.push("--create-database");
  const provider = config.provider;
  if (provider.name !== "fixture") {
    args.push(
      `--${provider.name}-secret`,
      provider.secret_name,
      `--${provider.name}-approved-cost-microusd`,
      String(provider.approved_cost_microusd),
      `--${provider.name}-daily-cost-microusd`,
      String(provider.daily_cost_microusd ?? provider.approved_cost_microusd),
    );
    if (["brave", "serper", "deepseek"].includes(provider.name))
      args.push(
        `--${provider.name}-request-cost-microusd`,
        String(provider.request_cost_microusd),
      );
    if (provider.model)
      args.push(
        "--openai-model",
        provider.model.name,
        "--openai-secret",
        provider.model.secret_name,
        ...(provider.model.reasoning_effort !== undefined
          ? ["--openai-reasoning-effort", provider.model.reasoning_effort]
          : []),
      );
    if (provider.embedding)
      args.push(
        "--embedding-model",
        provider.embedding.name,
        "--embedding-secret",
        provider.embedding.secret_name,
      );
  }
  return args;
}
const run = (command, args, cwd, env = process.env) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "pipe",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) fail("local_preparation_failed");
};
export async function reconcileFlight(
  client,
  receipt,
  flightId,
  config,
  expectedConfiguration,
) {
  if (!uuid.test(flightId)) fail("invalid_recovery_flight_id");
  const summary = (
    await client.query(
      `SELECT name,current_version,schedule_cron FROM md_get_flight(flight_id := '${flightId}'::UUID)`,
    )
  ).rows[0];
  const number = Number(summary?.current_version);
  if (
    !summary ||
    summary.schedule_cron ||
    summary.name !== receipt.flight_name ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > 4294967295
  )
    fail("flight_recovery_mismatch");
  const detail = (
    await client.query(
      `SELECT instance_type,max_runtime_sec,CAST(config AS JSON)::VARCHAR AS config_json,sha256(source_code) AS source_hash,sha256(requirements_txt) AS requirements_hash,CAST(flight_secret_names AS JSON)::VARCHAR AS secrets_json FROM md_get_flight_version(flight_id := '${flightId}'::UUID,version_number := ${number}::UINTEGER)`,
    )
  ).rows[0];
  const observed = JSON.parse(detail?.config_json ?? "{}"),
    boundSecrets = JSON.parse(detail?.secrets_json ?? "[]");
  if (
    !detail ||
    detail.instance_type !== "F4" ||
    Number(detail.max_runtime_sec) !== 120 ||
    detail.source_hash !== receipt.flight_source_sha256 ||
    detail.requirements_hash !== receipt.requirements_sha256 ||
    JSON.stringify(Object.keys(observed).sort()) !==
      JSON.stringify(Object.keys(expectedConfiguration).sort()) ||
    Object.entries(expectedConfiguration).some(
      ([key, value]) => observed[key] !== value,
    ) ||
    !Array.isArray(boundSecrets) ||
    JSON.stringify([...boundSecrets].sort()) !==
      JSON.stringify(
        providerBindings(config)
          .map((binding) => binding.name)
          .sort(),
      )
  )
    fail("flight_recovery_mismatch");
  Object.assign(receipt, {
    flight_id: flightId,
    current_version: number,
    recovered: true,
  });
}

export function ownerBearer(workspace, environment) {
  const path = join(workspace, "owner-secret.json");
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    fail("unsafe_state_path");
  const persisted = existsSync(path) ? readJSON(path).token : undefined;
  const explicit = environment.RESEARCH_BEARER_TOKEN;
  const valid = (value) =>
    typeof value === "string" && /^[\x21-\x7e]{32,4096}$/.test(value);
  if (
    (persisted !== undefined && !valid(persisted)) ||
    (explicit !== undefined && !valid(explicit))
  )
    fail("invalid_owner_credential");
  if (
    persisted !== undefined &&
    explicit !== undefined &&
    persisted !== explicit
  )
    fail("owner_credential_conflict");
  const token = persisted ?? explicit ?? randomBytes(36).toString("base64url");
  if (!existsSync(path)) savePrivate(path, { token });
  return token;
}

export async function applyPlan(
  plan,
  root,
  workspace,
  environment,
  state,
  save,
  injected = {},
) {
  const config = plan.config;
  if (
    injected.retryDeploymentId &&
    injected.retryDeploymentId !== state.deployment_id
  )
    fail("retry_deployment_id_mismatch");
  const validProviderKey = (key) =>
    typeof key === "string" && /^[\x21-\x7e]{1,4096}$/.test(key);
  for (const binding of providerBindings(config)) {
    if (
      !binding.reuse &&
      !state[binding.statePrefix + "_secret_ready"] &&
      !state[binding.statePrefix + "_secret_attempted"] &&
      !validProviderKey(environment[binding.keyName])
    )
      fail(
        binding.keyName === "OPENAI_API_KEY"
          ? "missing_or_invalid_model_credential"
          : "missing_or_invalid_provider_credential",
      );
  }
  if (!environment.VERCEL_TOKEN || !environment.MOTHERDUCK_TOKEN)
    fail("missing_credentials");
  const bearer = ownerBearer(workspace, environment);
  const api =
    injected.api ??
    ((path, body, options) =>
      vercelAPI(config, environment.VERCEL_TOKEN, path, body, options));
  const account = await api(
    config.team_id ? `/v2/teams/${config.team_id}` : "/v2/user",
  );
  if ((account.id ?? account.user?.id) !== config.account_id)
    fail("vercel_account_mismatch");
  if (!config.team_id && (account.user ?? account).defaultTeamId)
    fail("vercel_personal_scope_requires_explicit_team");
  let project = await api(
    `/v9/projects/${encodeURIComponent(state.project_id ?? config.project)}`,
    undefined,
    { allow404: true },
  );
  if (!project) {
    if (state.project_creation_attempted)
      fail("project_creation_uncertain_inspect_project");
    state.project_creation_attempted = true;
    save();
    project = await api("/v11/projects", {
      name: config.project,
      framework: null,
      installCommand: "npm ci",
      buildCommand: "npm run build:vercel",
      outputDirectory: "dist",
    });
  } else if (
    state.project_creation_attempted &&
    !state.project_id &&
    injected.recoverProjectId !== project.id
  ) {
    fail("project_creation_uncertain_reconcile_known_project");
  } else if (
    !state.project_id &&
    !state.project_creation_attempted &&
    !config.adopt_existing_project
  )
    fail("existing_project_requires_review");
  if (
    project.name !== config.project ||
    project.accountId !== config.account_id ||
    (state.project_id && project.id !== state.project_id)
  )
    fail("project_destination_mismatch");
  state.project_id = project.id;
  save();
  const prerequisite = await ensurePreviewPrerequisite(
    plan,
    project,
    state,
    save,
    api,
  );
  if (!prerequisite.ready) return prerequisite;
  if (!state.dependencies_ready) {
    (injected.run ?? run)(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      join(root, "apps/research"),
      Object.fromEntries(
        Object.entries(environment).filter(([key]) =>
          ["PATH", "HOME", "SYSTEMROOT", "TMPDIR"].includes(key),
        ),
      ),
    );
    state.dependencies_ready = true;
    save();
  }
  const require = createRequire(join(root, "apps/research/package.json"));
  const connect =
    injected.connect ??
    (async () => {
      const { Client } = require("pg");
      const client = new Client({
        host: config.motherduck_host,
        port: 5432,
        user: "user",
        password: environment.MOTHERDUCK_TOKEN,
        database: config.create_database ? "my_db" : config.database,
        ssl: { rejectUnauthorized: true },
        connectionTimeoutMillis: 15000,
        query_timeout: 30000,
      });
      await client.connect();
      return client;
    });
  for (const binding of providerBindings(config)) {
    const readyKey = binding.statePrefix + "_secret_ready",
      attemptedKey = binding.statePrefix + "_secret_attempted";
    if (state[readyKey]) continue;
    const client = await connect();
    try {
      const existing = (
        await client.query(
          "SELECT name,type,storage FROM duckdb_secrets() WHERE name=" +
            literal(binding.name),
        )
      ).rows;
      if (existing.length) {
        if (
          existing.length !== 1 ||
          String(existing[0].type).toLowerCase() !== "flights" ||
          (!binding.reuse && !state[attemptedKey])
        )
          fail("existing_secret_requires_review");
      } else {
        const keyName = binding.keyName,
          key = environment[keyName];
        if (!validProviderKey(key))
          fail("missing_or_invalid_provider_credential");
        state[attemptedKey] = true;
        save();
        await client.query(
          `CREATE SECRET "${binding.name}" IN MOTHERDUCK (TYPE FLIGHTS, PARAMS MAP {${literal(keyName)}: ${literal(key)}})`,
        );
      }
      state[readyKey] = true;
      save();
    } finally {
      await client.end();
    }
  }
  const setupModule =
    injected.setupModule ??
    (await import(new URL("./setup.mjs", import.meta.url)));
  const options = setupModule.parseArguments(
    setupArguments(config, workspace),
    { MOTHERDUCK_HOST: config.motherduck_host },
  );
  const receiptPath = join(workspace, "flight.json");
  if (
    !existsSync(receiptPath) ||
    setupModule.isRetryableFlightReceipt?.(readJSON(receiptPath))
  ) {
    (injected.run ?? run)(
      process.execPath,
      [join(root, "hosted/setup.mjs"), ...setupArguments(config, workspace)],
      root,
      { ...environment, MOTHERDUCK_HOST: config.motherduck_host },
    );
  }
  const receipt = readJSON(receiptPath);
  if (!uuid.test(receipt.flight_id ?? "") && injected.recoverFlightId) {
    const client = await connect();
    try {
      await reconcileFlight(
        client,
        receipt,
        injected.recoverFlightId,
        config,
        setupModule.flightConfiguration(
          options,
          receipt.namespace,
          receipt.storage_schema,
        ),
      );
      savePrivate(receiptPath, receipt);
    } finally {
      await client.end();
    }
  }
  if (!uuid.test(receipt.flight_id ?? ""))
    fail("flight_creation_uncertain_reconcile_receipt");
  if (
    receipt.database !== config.database ||
    receipt.host !== config.motherduck_host ||
    receipt.namespace !== digest(config.principal) ||
    receipt.flight_source_sha256 !== plan.flight_source_sha256 ||
    receipt.requirements_sha256 !== plan.requirements_sha256
  )
    fail("flight_receipt_mismatch");
  state.flight_id = receipt.flight_id;
  save();
  const settings = environmentSettings(
    config,
    setupModule.outputSettings(options, receipt),
    { ...environment, RESEARCH_BEARER_TOKEN: bearer },
  );
  if (!state.environment_ready) {
    const response = await api(
      `/v10/projects/${state.project_id}/env?upsert=true`,
      Object.entries(settings).map(([key, value]) => ({
        key,
        value,
        type: "encrypted",
        target: ["preview"],
      })),
    );
    if (response.failed?.length) fail("vercel_environment_incomplete");
    state.environment_ready = true;
    save();
  }
  if (!state.deployment_id) {
    if (state.deployment_attempted) {
      const found = await api(
        `/v6/deployments?projectId=${state.project_id}&limit=100`,
      );
      if (!uuid.test(state.deployment_attempt_id ?? ""))
        fail("deployment_uncertain_inspect_project");
      const matches = found.deployments.filter(
        (entry) =>
          entry.meta?.sourcesqlSetup === plan.plan_sha256 &&
          entry.meta?.sourcesqlAttempt === state.deployment_attempt_id,
      );
      if (matches.length !== 1) fail("deployment_uncertain_inspect_project");
      state.deployment_id = matches[0].uid ?? matches[0].id;
      save();
    } else {
      const files = await uploadDeploymentFiles(plan, root, state, save, api);
      state.deployment_attempt_id ??= randomUUID();
      state.deployment_attempted = true;
      save();
      const deployment = await api("/v13/deployments", {
        name: config.project,
        project: state.project_id,
        files,
        meta: {
          sourcesqlSetup: plan.plan_sha256,
          sourcesqlAttempt: state.deployment_attempt_id,
        },
        projectSettings: {
          framework: null,
          nodeVersion: "24.x",
          installCommand: "npm ci",
          buildCommand: "npm run build:vercel",
          outputDirectory: "dist",
        },
      });
      state.deployment_id = deployment.id;
      save();
    }
  }
  const deployment = await api(`/v13/deployments/${state.deployment_id}`);
  if (
    deployment.target === "production" ||
    deployment.projectId !== state.project_id ||
    deployment.meta?.sourcesqlSetup !== plan.plan_sha256 ||
    deployment.meta?.sourcesqlAttempt !== state.deployment_attempt_id
  )
    fail("deployment_destination_mismatch");
  state.deployment_state = deployment.readyState;
  save();
  if (["ERROR", "CANCELED"].includes(deployment.readyState)) {
    if (!injected.retryDeploymentId)
      return {
        ready: false,
        terminal: true,
        deployment_id: state.deployment_id,
        deployment_state: deployment.readyState,
        resume: `Inspect the failed deployment. To deliberately create one replacement, repeat apply with the same approved plan and --retry-deployment ${state.deployment_id}.`,
      };
    state.deployment_history ??= [];
    state.deployment_history.push({
      deployment_id: state.deployment_id,
      attempt_id: state.deployment_attempt_id,
      terminal_state: deployment.readyState,
    });
    delete state.deployment_id;
    delete state.deployment_attempt_id;
    state.deployment_attempted = false;
    state.alias_ready = false;
    save();
    return applyPlan(plan, root, workspace, environment, state, save, {
      ...injected,
      retryDeploymentId: undefined,
    });
  }
  if (injected.retryDeploymentId) fail("deployment_not_terminal_retry_refused");
  if (deployment.readyState !== "READY")
    return {
      ready: false,
      deployment_state: deployment.readyState,
      resume:
        "Repeat apply with the same approved plan; no new deployment is created.",
    };
  if (!state.alias_ready) {
    const currentAlias = await api(
      `/v4/aliases/${encodeURIComponent(config.alias)}`,
      undefined,
      { allow404: true },
    );
    if (currentAlias && currentAlias.projectId !== state.project_id)
      fail("alias_belongs_to_different_project");
    await api(`/v2/deployments/${state.deployment_id}/aliases`, {
      alias: config.alias,
    });
    state.alias_ready = true;
    save();
  }
  return {
    ready: true,
    endpoint: "https://" + config.alias + "/mcp",
    execution_enabled: config.enable_execution === true,
    next: "Review the exact alias protection exception and run verify; client OAuth/App rendering require their own checks.",
  };
}

export async function verify(
  plan,
  root,
  workspace,
  runFixture,
  state,
  save,
  environment = process.env,
) {
  const require = createRequire(join(root, "apps/research/package.json"));
  const {
    Client,
    StreamableHTTPClientTransport,
  } = require("@modelcontextprotocol/client");
  const bearer = ownerBearer(workspace, environment);
  const endpoint = "https://" + plan.config.alias;
  const headers = {
    Authorization: "Bearer " + bearer,
    ...(environment.VERCEL_AUTOMATION_BYPASS_SECRET
      ? {
          "x-vercel-protection-bypass":
            environment.VERCEL_AUTOMATION_BYPASS_SECRET,
        }
      : {}),
  };
  const client = new Client({ name: "sourcesql-onboarding", version: "1" });
  const call = async (name, arguments_) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    if (result.isError) fail("fixture_tool_failed");
    return (
      result.structuredContent ??
      JSON.parse(result.content.find((part) => part.type === "text").text)
    );
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpoint + "/mcp"), {
        requestInit: { headers },
      }),
    );
    const tools = await client.listTools();
    for (const name of [
      "open_research",
      "sourcesql_query",
      "sourcesql_job_status",
    ])
      if (!tools.tools.some((tool) => tool.name === name))
        fail("missing_mcp_tool");
    assertCapabilities(plan.config, await call("sourcesql_capabilities", {}));
    if (runFixture) {
      if (!plan.config.enable_execution)
        fail("fixture_execution_not_in_reviewed_plan");
      state.fixture_request_id ??= randomUUID();
      save();
      const result = state.fixture_result?.job_id
        ? await call("sourcesql_job_status", {
            job_id: state.fixture_result.job_id,
          })
        : await call("sourcesql_query", {
            request_id: state.fixture_request_id,
            profile: "fixture",
            query:
              "SELECT title, url FROM WEB_SEARCH('fictional Aurora Birch campuses') ORDER BY url LIMIT 2",
          });
      // The gateway returns a durable handle. A repeat reuses the request and never fabricates a fresh one.
      state.fixture_result = result;
      save();
      return {
        connected: true,
        fixture_request_id: state.fixture_request_id,
        result,
        next: "Poll the returned job_id without submitting a new request. Re-run this verify command with --run-fixture to recover the same fixture request.",
      };
    }
    if (state.fixture_result?.job_id && !state.fixture_result.result_id) {
      state.fixture_result = await call("sourcesql_job_status", {
        job_id: state.fixture_result.job_id,
      });
      save();
    }
    if (state.fixture_result?.result_id) {
      await call("sourcesql_read_result", {
        result_id: state.fixture_result.result_id,
      });
      state.fixture_reopened = true;
      save();
    }
    return {
      fixture_reopened: state.fixture_reopened === true,
      connected: true,
      tools_discovered: tools.tools.length,
      configured_capabilities_verified: true,
      flights_submitted: 0,
      provider_calls: 0,
      host_rendering_qualified: false,
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args,
    values = {};
  const booleanFlags = new Set(["--run-fixture"]);
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (
      ![
        "--root",
        "--workspace",
        "--config",
        "--approve-plan",
        "--run-fixture",
        "--recover-flight",
        "--recover-project",
        "--retry-deployment",
      ].includes(flag) ||
      flag in values
    )
      fail("invalid_arguments");
    values[flag] = booleanFlags.has(flag) ? true : rest[++index];
  }
  if (
    !["plan", "apply", "status", "verify"].includes(command) ||
    !values["--root"] ||
    !values["--workspace"]
  )
    fail("invalid_arguments");
  if (Number(process.versions.node.split(".")[0]) !== 24)
    fail("node_24_required");
  const root = resolve(values["--root"]),
    workspace = resolve(values["--workspace"]),
    planPath = join(workspace, "plan.json"),
    statePath = join(workspace, "state.json");
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  if (command === "plan") {
    if (!values["--config"]) fail("config_required");
    const plan = createPlan(
      readJSON(resolve(values["--config"])),
      root,
      workspace,
    );
    if (
      existsSync(planPath) &&
      JSON.stringify(readJSON(planPath)) !== JSON.stringify(plan)
    )
      fail("existing_workspace_plan_differs");
    savePrivate(planPath, plan);
    console.log(
      JSON.stringify(
        {
          ...plan,
          prerequisites: {
            node_24: true,
            npm:
              spawnSync("npm", ["--version"], { stdio: "pipe" }).status === 0,
          },
          secrets_required: [
            "VERCEL_TOKEN",
            "MOTHERDUCK_TOKEN",
            ...new Set(
              providerBindings(plan.config)
                .filter((binding) => !binding.reuse)
                .map((binding) => binding.keyName),
            ),
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  const plan = readJSON(planPath),
    state = existsSync(statePath)
      ? readJSON(statePath)
      : {
          schema: "sourcesql.personal-cloud-state.v1",
          plan_sha256: plan.plan_sha256,
        };
  if (state.plan_sha256 !== plan.plan_sha256) fail("state_plan_mismatch");
  const save = () => savePrivate(statePath, state);
  if (command === "status") {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  assertPlan(
    plan,
    createPlan(plan.config, root, workspace),
    values["--approve-plan"],
  );
  const lock = join(workspace, "apply.lock");
  let handle;
  try {
    const fs = await import("node:fs/promises");
    handle = await fs.open(lock, "wx", 0o600);
    const result =
      command === "apply"
        ? await applyPlan(plan, root, workspace, process.env, state, save, {
            recoverFlightId: values["--recover-flight"],
            recoverProjectId: values["--recover-project"],
            retryDeploymentId: values["--retry-deployment"],
          })
        : await verify(
            plan,
            root,
            workspace,
            values["--run-fixture"],
            state,
            save,
          );
    console.log(JSON.stringify(result, null, 2));
    if (result.terminal) process.exitCode = 1;
  } finally {
    if (handle) {
      await handle.close();
      await (await import("node:fs/promises")).unlink(lock);
    }
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(
      JSON.stringify({
        completed: false,
        reason: error.safe
          ? error.message
          : error.code === "EEXIST"
            ? "setup_already_running_or_interrupted_inspect_lock"
            : "setup_operation_failed_inspect_local_state",
        secrets_logged: false,
      }),
    );
    process.exitCode = 1;
  }
}
