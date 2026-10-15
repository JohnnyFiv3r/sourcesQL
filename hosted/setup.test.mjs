import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
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
  outputSettings,
  parseArguments,
  main,
} from "./setup.mjs";
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
    search_types: { exa: "auto", exa_deep: "deep", exa_deep_reasoning: "deep-reasoning" },
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
