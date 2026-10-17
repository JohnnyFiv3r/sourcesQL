import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flightConfiguration,
  flightSQL,
  flightSecretNames,
  outputSettings,
  parseArguments,
  isRetryableFlightReceipt,
  main,
} from "./setup.mjs";
import {
  exaConfiguration,
  exaDescriptor,
  exaFingerprint,
} from "../apps/research/server/hosted-exa.ts";
const require = createRequire(
  new URL("../apps/research/package.json", import.meta.url),
);
const { Client } = require("pg");
const base = ["--database", "synthetic_test", "--principal", "owner-a"];
const namespace = "a".repeat(64),
  schema = "sourcesql_" + namespace.slice(0, 32);
const receipt = {
  flight_id: "11111111-1111-4111-a111-111111111111",
  flight_source_sha256: "b".repeat(64),
  requirements_sha256: "c".repeat(64),
};

test("explicit model and embedding setup matches the gateway and Flight research contract", () => {
  const configurations = [
    [
      "--openai-model",
      "gpt-4.1-mini",
      "--openai-secret",
      "personal_openai",
      "--openai-reasoning-effort",
      "low",
    ],
    [
      "--embedding-model",
      "text-embedding-3-small",
      "--embedding-secret",
      "personal_openai",
    ],
    [
      "--openai-model",
      "gpt-4.1-mini",
      "--openai-secret",
      "personal_openai",
      "--embedding-model",
      "text-embedding-3-large",
      "--embedding-secret",
      "personal_openai",
    ],
  ].map((flags) =>
    parseArguments([...base, "--exa-secret", "personal_exa", ...flags], {}),
  );
  for (const options of configurations) {
    assert.deepEqual(options.exa.descriptor, exaDescriptor(options.exa.policy));
    assert.equal(
      options.exa.providerPolicySha256,
      exaFingerprint(options.exa.policy),
    );
    const flight = flightConfiguration(options, namespace, schema);
    const settings = outputSettings(options, receipt);
    for (const [key, value] of Object.entries(
      exaConfiguration(options.exa.policy),
    )) {
      assert.equal(flight[key], value);
      assert.equal(settings[key], value);
    }
    assert.equal(settings.SOURCESQL_ALLOW_FLIGHT_SUBMISSION, "0");
    assert.deepEqual(flightSecretNames(options), [
      "personal_exa",
      "personal_openai",
    ]);
    const sql = flightSQL(
      options,
      "reviewed",
      "pass",
      "reviewed==1",
      namespace,
      schema,
    );
    assert.match(
      sql,
      /flight_secret_names := \['personal_exa','personal_openai'\]/,
    );
    assert.doesNotMatch(sql, /API_KEY|md_run_flight/);
  }
  const python =
    process.env.SOURCESQL_TEST_PYTHON ??
    process.env.SOURCESQL_PYTHON ??
    join(import.meta.dirname, "../local/python312/venv/bin/python");
  const result = spawnSync(
    python,
    [
      "-B",
      "-c",
      `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('setup_policy', sys.argv[1])
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
print(json.dumps([{'descriptor': policy.load_configuration(env)['descriptor'], 'fingerprint': policy.load_configuration(env)['provider_policy_sha256']} for env in json.load(sys.stdin)]))
`,
      join(import.meta.dirname, "flight/exa_profile.py"),
    ],
    {
      input: JSON.stringify(
        configurations.map((options) => exaConfiguration(options.exa.policy)),
      ),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(result.stdout),
    configurations.map((options) => ({
      descriptor: options.exa.descriptor,
      fingerprint: options.exa.providerPolicySha256,
    })),
  );
});

test("partial model configuration and search-secret collisions refuse before provisioning", () => {
  for (const flags of [
    ["--openai-model", "gpt-4.1-mini"],
    ["--openai-secret", "personal_openai"],
    ["--openai-reasoning-effort", "low"],
    ["--embedding-secret", "personal_openai"],
    ["--embedding-model", "text-embedding-3-small"],
    [
      "--embedding-model",
      "unreviewed",
      "--embedding-secret",
      "personal_openai",
    ],
    ["--openai-model", "gpt-4.1-mini", "--openai-secret", "personal_exa"],
    [
      "--embedding-model",
      "text-embedding-3-small",
      "--embedding-secret",
      "personal_exa",
    ],
  ])
    assert.throws(
      () =>
        parseArguments([...base, "--exa-secret", "personal_exa", ...flags], {}),
      /invalid_configuration/,
    );
  assert.throws(
    () =>
      parseArguments(
        [
          ...base,
          "--embedding-model",
          "text-embedding-3-small",
          "--embedding-secret",
          "personal_openai",
        ],
        {},
      ),
    /invalid_configuration/,
  );
});

for (const provider of ["brave", "serper"]) {
  test(`${provider} setup selects exactly one named Flight secret and records a conservative estimate`, () => {
    const options = parseArguments(
      [
        ...base,
        `--${provider}-secret`,
        `sourcesql_${provider}`,
        `--${provider}-request-cost-microusd`,
        "5000",
      ],
      {},
    );
    assert.equal(options.exa, undefined);
    assert.deepEqual(options.search.descriptor, {
      approved_cost_microusd: 50000,
      provider,
      request_cost_microusd: 5000,
      secret_name: `sourcesql_${provider}`,
      version: `${provider}-search.v1`,
    });
    const sql = flightSQL(
      options,
      "reviewed_test",
      'print("reviewed")',
      "duckdb==1.5.0",
      namespace,
      schema,
    );
    assert.ok(sql.includes(`flight_secret_names := ['sourcesql_${provider}']`));
    assert.doesNotMatch(
      sql,
      /API_KEY|MOTHERDUCK_TOKEN|schedule_cron|md_run_flight/,
    );
    const settings = outputSettings(options, receipt);
    assert.equal(
      settings[`SOURCESQL_${provider.toUpperCase()}_REQUEST_COST_MICROUSD`],
      "5000",
    );
    assert.equal(
      settings[`SOURCESQL_${provider.toUpperCase()}_DAILY_COST_MICROUSD`],
      "1000000",
    );
    assert.equal(settings.SOURCESQL_ALLOW_FLIGHT_SUBMISSION, "0");
    assert.equal(
      options.search.providerPolicySha256,
      createHash("sha256")
        .update(JSON.stringify(options.search.descriptor))
        .digest("hex"),
    );
  });
  test(`${provider} setup requires explicit estimates and refuses mixed live providers`, () => {
    for (const extra of [
      [`--${provider}-secret`, "name"],
      [`--${provider}-request-cost-microusd`, "5000"],
      [
        `--${provider}-secret`,
        "UPPERCASE",
        `--${provider}-request-cost-microusd`,
        "5000",
      ],
      [
        `--${provider}-secret`,
        "name",
        `--${provider}-request-cost-microusd`,
        "0",
      ],
      [
        `--${provider}-secret`,
        "name",
        `--${provider}-request-cost-microusd`,
        "50001",
      ],
      [
        `--${provider}-secret`,
        "name",
        `--${provider}-request-cost-microusd`,
        "1.5",
      ],
      [
        `--${provider}-secret`,
        "name",
        `--${provider}-request-cost-microusd`,
        "5000",
        "--exa-secret",
        "exa_name",
      ],
      [
        "--brave-secret",
        "brave_name",
        "--brave-request-cost-microusd",
        "5000",
        "--serper-secret",
        "serper_name",
        "--serper-request-cost-microusd",
        "5000",
      ],
    ])
      assert.throws(
        () => parseArguments([...base, ...extra], {}),
        /invalid_configuration/,
      );
  });
}

test("fixture provisioning stays unscheduled, bounded and without secrets or Exa enablement", () => {
  const options = parseArguments(base, {});
  const sql = flightSQL(
    options,
    "reviewed_test",
    'print("reviewed")',
    "duckdb==1.5.0",
    namespace,
    schema,
  );
  assert.equal(options.exa, undefined);
  assert.match(sql, /instance_type := 'F4',max_runtime_sec := 120/);
  assert.doesNotMatch(
    sql,
    /flight_secret_names|schedule_cron|md_run_flight|SOURCESQL_ALLOW_LIVE_EXA/i,
  );
  assert.equal(
    outputSettings(options, receipt).SOURCESQL_ALLOW_FLIGHT_SUBMISSION,
    "0",
  );
});

test("Exa provisioning binds only the named secret and exports the exact token-free public policy", () => {
  const options = parseArguments(
    [...base, "--exa-secret", "sourcesql_exa"],
    {},
  );
  const sql = flightSQL(
    options,
    "reviewed_test",
    'print("reviewed")',
    "duckdb==1.5.0",
    namespace,
    schema,
  );
  assert.match(sql, /flight_secret_names := \['sourcesql_exa'\]/);
  assert.doesNotMatch(
    sql,
    /EXA_API_KEY|MOTHERDUCK_TOKEN|schedule_cron|md_run_flight/,
  );
  assert.deepEqual(options.exa.descriptor, {
    approved_cost_microusd: 50000,
    search_types: {
      exa: "auto",
      exa_deep: "deep",
      exa_deep_reasoning: "deep-reasoning",
    },
    secret_name: "sourcesql_exa",
    version: "exa-research.v2",
  });
  assert.equal(
    options.exa.providerPolicySha256,
    "5e31ea3484b972d2f9b0c9e69ad88f226582b19234e236bc6c3dca5bf0e1e901",
  );
  const config = flightConfiguration(options, namespace, schema);
  assert.equal(config.SOURCESQL_ALLOW_LIVE_EXA, "1");
  assert.equal(config.SOURCESQL_EXA_POLICY_VERSION, "exa-research.v2");
  assert.equal(config.SOURCESQL_EXA_SECRET_NAME, "sourcesql_exa");
  assert.equal(config.SOURCESQL_EXA_APPROVED_COST_MICROUSD, "50000");
  const settings = outputSettings(options, receipt);
  assert.equal(settings.SOURCESQL_EXA_POLICY_VERSION, "exa-research.v2");
  assert.equal(settings.SOURCESQL_EXA_DAILY_COST_MICROUSD, "1000000");
  assert.equal(settings.SOURCESQL_ALLOW_FLIGHT_SUBMISSION, "0");
  assert.ok(
    !Object.keys(settings).some(
      (key) => key.includes("TOKEN") || key.includes("API_KEY"),
    ),
  );
});

test("explicit bounded Exa policy is normalized without taking values from provider environment", () => {
  const options = parseArguments(
    [
      ...base,
      "--exa-secret",
      "sourcesql_exa",
      "--exa-approved-cost-microusd",
      "10000",
      "--exa-daily-cost-microusd",
      "20000",
    ],
    { EXA_API_KEY: "SYNTHETIC-KEY-MUST-NOT-BE-SAVED" },
  );
  assert.equal(options.exa.descriptor.approved_cost_microusd, 10000);
  assert.equal(options.exa.dailyCostMicrousd, 20000);
  assert.ok(!JSON.stringify(options).includes("SYNTHETIC-KEY"));
});

test("unknown, duplicate or missing-value options refuse before credentials or network access", () => {
  for (const arguments_ of [
    [...base, "--unknown", "SYNTHETIC-KEY"],
    [...base, "--exa-secret"],
    [...base, "--exa-secret", "--output", "test.json"],
    [...base, "--database", "other"],
    [...base, "--create-database", "--create-database"],
    [...base, "unexpected-positional"],
  ]) {
    assert.throws(() => parseArguments(arguments_, {}), /invalid_arguments/);
  }
});

test("Exa limits require an explicit secret and cannot exceed the phase ceiling", () => {
  for (const extra of [
    ["--exa-approved-cost-microusd", "50000"],
    ["--exa-daily-cost-microusd", "1000000"],
    ["--exa-secret", "UPPERCASE"],
    ["--exa-secret", "a".repeat(64)],
    ["--exa-secret", "name'quoted"],
    ["--exa-secret", "sourcesql_exa", "--exa-approved-cost-microusd", "0"],
    ["--exa-secret", "sourcesql_exa", "--exa-approved-cost-microusd", "1.5"],
    [
      "--exa-secret",
      "sourcesql_exa",
      "--exa-approved-cost-microusd",
      "1000001",
    ],
    ["--exa-secret", "sourcesql_exa", "--exa-daily-cost-microusd", "10000"],
    ["--exa-secret", "sourcesql_exa", "--exa-daily-cost-microusd", "1000001"],
  ]) {
    assert.throws(
      () => parseArguments([...base, ...extra], {}),
      /invalid_configuration/,
    );
  }
});

test("existing setup receipt refuses retry before creating any connection", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "sourcesql-setup-test-"));
  const output = join(directory, "receipt.json");
  const previousExit = process.exitCode;
  writeFileSync(output, '{"prior_attempt":true}\n', { mode: 0o600 });
  let connections = 0;
  context.mock.method(Client.prototype, "connect", async () => {
    connections++;
  });
  const errors = [];
  context.mock.method(console, "error", (value) =>
    errors.push(JSON.parse(value)),
  );
  try {
    await main([...base, "--output", output]);
    assert.equal(connections, 0);
    assert.equal(readFileSync(output, "utf8"), '{"prior_attempt":true}\n');
    assert.equal(
      errors[0].reason,
      "setup_already_attempted_inspect_saved_receipt",
    );
  } finally {
    process.exitCode = previousExit;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a lost creation response leaves a private receipt and cannot blindly create another Flight", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "sourcesql-setup-lost-"));
  const output = join(directory, "receipt.json");
  const previousExit = process.exitCode,
    previousToken = process.env.MOTHERDUCK_TOKEN;
  const source = "print('SAFE-PUBLIC-SOURCE')",
    requirements = "duckdb==1.5.0\n";
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  writeFileSync(join(directory, "flight.py"), source);
  writeFileSync(join(directory, "requirements.txt"), requirements);
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      flight_source_sha256: hash(source),
      requirements_sha256: hash(requirements),
      wheel_sha256: "d".repeat(64),
      credentials_embedded: false,
    }),
  );
  process.env.MOTHERDUCK_TOKEN = "SAFE-SYNTHETIC-SETUP-TOKEN";
  let submissions = 0;
  context.mock.method(Client.prototype, "connect", async () => {});
  context.mock.method(Client.prototype, "query", async () => {
    submissions++;
    throw Error("SAFE-SYNTHETIC-LOST-RESPONSE");
  });
  context.mock.method(Client.prototype, "end", async () => {});
  const errors = [];
  context.mock.method(console, "error", (value) =>
    errors.push(JSON.parse(value)),
  );
  try {
    const arguments_ = [
      ...base,
      "--bundle",
      directory,
      "--output",
      output,
      "--exa-secret",
      "sourcesql_exa",
    ];
    await main(arguments_);
    const saved = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(saved.scheduled, false);
    assert.equal(saved.jobs_submitted, 0);
    assert.equal(
      saved.provider_policy_sha256,
      "5e31ea3484b972d2f9b0c9e69ad88f226582b19234e236bc6c3dca5bf0e1e901",
    );
    assert.ok(saved.flight_name);
    assert.equal(saved.phase, "creating");
    assert.equal(saved.flight_creation_attempted, true);
    assert.equal(isRetryableFlightReceipt(saved), false);
    assert.equal(saved.flight_id, undefined);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(existsSync(output + ".env"), false);
    assert.ok(!JSON.stringify(saved).includes("SAFE-SYNTHETIC-SETUP-TOKEN"));
    await main(arguments_);
    assert.equal(submissions, 1);
    assert.equal(errors[0].reason, "remote_operation_failed");
    assert.equal(
      errors[1].reason,
      "setup_already_attempted_inspect_saved_receipt",
    );
  } finally {
    process.exitCode = previousExit;
    if (previousToken === undefined) delete process.env.MOTHERDUCK_TOKEN;
    else process.env.MOTHERDUCK_TOKEN = previousToken;
    rmSync(directory, { recursive: true, force: true });
  }
});

function preparedBundle(directory) {
  const source = "print('SAFE-PUBLIC-SOURCE')",
    requirements = "duckdb==1.5.0\n";
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  writeFileSync(join(directory, "flight.py"), source);
  writeFileSync(join(directory, "requirements.txt"), requirements);
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      flight_source_sha256: hash(source),
      requirements_sha256: hash(requirements),
      wheel_sha256: "d".repeat(64),
      credentials_embedded: false,
    }),
  );
}

test("only an explicit prepared receipt with no creation identity permits retry", () => {
  const prepared = {
    schema: "sourcesql.hosted-setup.v1",
    phase: "prepared",
    flight_creation_attempted: false,
  };
  assert.equal(isRetryableFlightReceipt(prepared), true);
  for (const receipt of [
    undefined,
    null,
    {},
    { flight_name: "legacy_unknown" },
    { ...prepared, flight_creation_attempted: true },
    { ...prepared, phase: "creating" },
    { ...prepared, phase: "created" },
    { ...prepared, flight_name: "possibly_created" },
    { ...prepared, flight_id: "11111111-1111-4111-a111-111111111111" },
    { ...prepared, schema: "unknown" },
  ])
    assert.equal(isRetryableFlightReceipt(receipt), false);
});

test("a MotherDuck connection failure can resume safely before the Flight creation barrier", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "sourcesql-setup-prepared-"));
  const output = join(directory, "receipt.json");
  const previousExit = process.exitCode,
    previousToken = process.env.MOTHERDUCK_TOKEN;
  preparedBundle(directory);
  process.env.MOTHERDUCK_TOKEN = "SAFE-SYNTHETIC-SETUP-TOKEN";
  let connections = 0,
    creations = 0;
  context.mock.method(Client.prototype, "connect", async () => {
    connections++;
    if (connections === 1) throw Error("SAFE-SYNTHETIC-CONNECTION-FAILURE");
  });
  context.mock.method(Client.prototype, "query", async (sql) => {
    assert.match(sql, /md_create_flight/);
    const saved = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(saved.phase, "creating");
    assert.equal(saved.flight_creation_attempted, true);
    assert.ok(saved.flight_name);
    creations++;
    return {
      rows: [
        {
          flight_id: "11111111-1111-4111-a111-111111111111",
          current_version: 1,
        },
      ],
    };
  });
  context.mock.method(Client.prototype, "end", async () => {});
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "log", () => {});
  const args = [...base, "--bundle", directory, "--output", output];
  try {
    await main(args);
    const prepared = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(isRetryableFlightReceipt(prepared), true);
    assert.equal(creations, 0);
    assert.equal(existsSync(output + ".lock"), false);
    await main(args);
    const saved = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(saved.phase, "created");
    assert.equal(saved.flight_creation_attempted, true);
    assert.equal(saved.creation_attempted_at, prepared.creation_attempted_at);
    assert.equal(connections, 2);
    assert.equal(creations, 1);
    assert.equal(existsSync(output + ".env"), true);
    assert.equal(existsSync(output + ".lock"), false);
    assert.ok(!JSON.stringify(saved).includes("SAFE-SYNTHETIC-SETUP-TOKEN"));
    await main(args);
    assert.equal(connections, 2);
    assert.equal(creations, 1);
  } finally {
    process.exitCode = previousExit;
    if (previousToken === undefined) delete process.env.MOTHERDUCK_TOKEN;
    else process.env.MOTHERDUCK_TOKEN = previousToken;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a prepared retry cannot change the reviewed owner, provider grant or bundle", async (context) => {
  const directory = mkdtempSync(
    join(tmpdir(), "sourcesql-setup-retry-change-"),
  );
  const output = join(directory, "receipt.json");
  const previousExit = process.exitCode,
    previousToken = process.env.MOTHERDUCK_TOKEN;
  preparedBundle(directory);
  process.env.MOTHERDUCK_TOKEN = "SAFE-SYNTHETIC-SETUP-TOKEN";
  let connections = 0;
  const errors = [];
  context.mock.method(Client.prototype, "connect", async () => {
    connections++;
    throw Error("SAFE-SYNTHETIC-CONNECTION-FAILURE");
  });
  context.mock.method(Client.prototype, "end", async () => {});
  context.mock.method(console, "error", (value) =>
    errors.push(JSON.parse(value)),
  );
  const args = [
    ...base,
    "--bundle",
    directory,
    "--output",
    output,
    "--brave-secret",
    "sourcesql_brave",
    "--brave-request-cost-microusd",
    "5000",
  ];
  try {
    await main(args);
    const saved = readFileSync(output, "utf8");
    await main([...args, "--brave-approved-cost-microusd", "60000"]);
    assert.equal(errors[1].reason, "setup_retry_configuration_changed");
    assert.equal(connections, 1);
    assert.equal(readFileSync(output, "utf8"), saved);
    await main([...args.slice(0, -2), "--brave-request-cost-microusd", "5001"]);
    assert.equal(errors[2].reason, "setup_retry_configuration_changed");
    assert.equal(connections, 1);
    assert.equal(readFileSync(output, "utf8"), saved);
    await main([
      "--database",
      "synthetic_test",
      "--principal",
      "other-owner",
      ...args.slice(4),
    ]);
    assert.equal(errors[3].reason, "setup_retry_configuration_changed");
    const changedSource = "print('CHANGED-SAFE-PUBLIC-SOURCE')";
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(join(directory, "flight.py"), changedSource);
    manifest.flight_source_sha256 = createHash("sha256")
      .update(changedSource)
      .digest("hex");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await main(args);
    assert.equal(errors[4].reason, "setup_retry_configuration_changed");
    assert.equal(connections, 1);
    assert.equal(readFileSync(output, "utf8"), saved);
  } finally {
    process.exitCode = previousExit;
    if (previousToken === undefined) delete process.env.MOTHERDUCK_TOKEN;
    else process.env.MOTHERDUCK_TOKEN = previousToken;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an existing setup lock refuses a concurrent retry without opening a connection", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "sourcesql-setup-locked-"));
  const output = join(directory, "receipt.json"),
    lock = output + ".lock";
  const previousExit = process.exitCode;
  writeFileSync(lock, "existing owner", { mode: 0o600 });
  let connections = 0;
  const errors = [];
  context.mock.method(Client.prototype, "connect", async () => {
    connections++;
  });
  context.mock.method(console, "error", (value) =>
    errors.push(JSON.parse(value)),
  );
  try {
    await main([...base, "--output", output]);
    assert.equal(
      errors[0].reason,
      "setup_already_running_or_interrupted_inspect_lock",
    );
    assert.equal(connections, 0);
    assert.equal(readFileSync(lock, "utf8"), "existing owner");
    assert.equal(existsSync(output), false);
  } finally {
    process.exitCode = previousExit;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("setup emits a worker-version pin only when the reviewed bundle receipt contains it", () => {
  const options = parseArguments(base, {});
  const legacy = outputSettings(options, receipt);
  assert.equal(legacy.SOURCESQL_FLIGHT_ENGINE_VERSION, undefined);
  const pinned = outputSettings(options, {
    ...receipt,
    engine_version: "0.2.2",
  });
  assert.equal(pinned.SOURCESQL_FLIGHT_ENGINE_VERSION, "0.2.2");
  assert.equal(
    pinned.SOURCESQL_FLIGHT_SOURCE_SHA256,
    receipt.flight_source_sha256,
  );
  assert.equal(
    pinned.SOURCESQL_FLIGHT_REQUIREMENTS_SHA256,
    receipt.requirements_sha256,
  );
});
