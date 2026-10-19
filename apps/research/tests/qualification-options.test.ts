import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseQualificationOptions,
  validateQualificationConfiguration,
  qualificationPlan,
  assertQualificationReceipt,
  qualificationExaPolicy,
  exactFlightRun,
  type Qualifier,
} from "../scripts/qualification-options.ts";
import {
  exaDescriptor,
  exaFingerprint,
  type HostedExaPolicy,
} from "../server/hosted-exa.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const principal = "synthetic-qualification-owner",
  namespace = digest(principal);
const flags = [
  "--setup",
  "local/test-setup.json",
  "--policy",
  "local/test-policy.json",
  "--principal",
  principal,
  "--output",
  "artifacts/test-qualification/receipt.json",
];
function fixture() {
  const setup = {
    schema: "sourcesql.hosted-setup.v1",
    namespace,
    storage_schema: "sourcesql_" + namespace.slice(0, 32),
    host: "pg.us-east-1-aws.motherduck.com",
    database: "sourcesql_test",
    flight_id: "0a111111-1111-4111-a111-111111111111",
    instance_type: "F4",
    scheduled: false,
    max_runtime_sec: 120,
    wheel_sha256: digest("synthetic wheel"),
    flight_source_sha256: digest("synthetic Flight"),
    requirements_sha256: digest("synthetic requirements"),
    engine_version: "0.2.3",
  };
  const setupText = JSON.stringify(setup);
  const policy = {
    schema: "sourcesql.qualification-policy.v1",
    setup_sha256: digest(setupText),
    source_commit: "1".repeat(40),
    usage_mode: "operator_reserved",
    max_runtime_sec: 120,
    daily_seconds: 120,
    monthly_seconds: null,
    monthly_provider_cost_microusd: null,
  };
  return { setup, setupText, policy, policyText: JSON.stringify(policy) };
}

test("hosted qualifiers require named setup, principal, reviewed policy and private receipt", () => {
  for (const flag of ["--setup", "--principal", "--policy", "--output"]) {
    const index = flags.indexOf(flag);
    assert.throws(
      () =>
        parseQualificationOptions(
          "storage",
          flags.filter((_, n) => n !== index && n !== index + 1),
        ),
      /qualification_requires_/,
    );
  }
  assert.throws(
    () =>
      parseQualificationOptions("storage", [
        ...flags,
        "--daily-seconds",
        "9999",
      ]),
    /invalid_qualification_arguments/,
  );
  assert.throws(
    () =>
      parseQualificationOptions("storage", [...flags, "--principal", "other"]),
    /invalid_qualification_arguments/,
  );
  assert.throws(
    () =>
      parseQualificationOptions("storage", [
        ...flags.slice(0, -2),
        "--output",
        "src/public.json",
      ]),
    /private_directory/,
  );
  assert.throws(
    () =>
      parseQualificationOptions("storage", [
        ...flags.slice(0, -2),
        "--output",
        "local/test-policy.json",
      ]),
    /separate_json/,
  );
});

test("qualifiers default to an offline plan and cannot silently submit or cancel", () => {
  assert.equal(parseQualificationOptions("storage", flags).execute, false);
  assert.equal(parseQualificationOptions("storage", flags).action, "status");
  assert.throws(
    () =>
      parseQualificationOptions("storage", [
        ...flags,
        "--action",
        "query",
        "--execute",
      ]),
    /requires_submit/,
  );
  const run = parseQualificationOptions("storage", [
    ...flags,
    "--action",
    "query",
    "--execute",
    "--submit",
  ]);
  assert.equal(run.execute && run.submit, true);
  assert.throws(
    () =>
      parseQualificationOptions("storage", [
        ...flags,
        "--action",
        "cancel-running",
        "--execute",
        "--submit",
      ]),
    /requires_allow_cancel/,
  );
  assert.throws(
    () =>
      parseQualificationOptions("storage", [...flags, "--action", "guards"]),
    /invalid_qualification_action/,
  );
  assert.throws(
    () =>
      parseQualificationOptions("storage", [
        ...flags,
        "--execute",
        "--dry-run",
      ]),
    /execution_mode_conflict/,
  );
  assert.throws(
    () => parseQualificationOptions("storage", [...flags, "--submit"]),
    /submit_not_applicable/,
  );
  assert.throws(
    () => parseQualificationOptions("storage", [...flags, "--discard-ack"]),
    /lost_ack_requires_fixture_query/,
  );
  assert.throws(
    () => parseQualificationOptions("app", flags),
    /requires_native_receipt_or_fixture/,
  );
});

test("fixture labels disclose remote database writes rather than claiming offline qualification", () => {
  const data = fixture(),
    options = parseQualificationOptions("app", [...flags, "--fixture"]);
  const plan = qualificationPlan(
    "app",
    options,
    validateQualificationConfiguration(
      options,
      data.setupText,
      data.policyText,
    ),
  );
  assert.equal(plan.dry_run, true);
  assert.equal(plan.effects_if_executed.remote_database, true);
  assert.equal(plan.effects_if_executed.fixture_means_offline, false);
  assert.equal(plan.effects_if_executed.flight_submission, false);
  assert.equal(plan.effects_if_executed.provider_calls, 0);
  assert.match(
    plan.effects_if_executed.database_writes,
    /persist synthetic state/,
  );
  assert.match(plan.qualification, /actual host rendering not tested/);
});

test("reviewed policy preserves metering mode and exact optional ledgers without historical defaults", () => {
  for (const mode of ["operator_reserved", "provider_managed"]) {
    const data = fixture(),
      options = parseQualificationOptions("storage", flags);
    const configuration = validateQualificationConfiguration(
      options,
      data.setupText,
      JSON.stringify({
        ...data.policy,
        usage_mode: mode,
        daily_seconds: null,
        monthly_seconds: 1800,
        monthly_provider_cost_microusd: 234567,
      }),
    );
    assert.equal(configuration.engineOptions.usageMode, mode);
    assert.equal(
      Object.hasOwn(configuration.engineOptions, "dailySeconds"),
      false,
    );
    assert.equal(configuration.engineOptions.monthlySeconds, 1800);
    assert.equal(
      configuration.engineOptions.monthlyProviderCostMicrousd,
      234567,
    );
    assert.equal(configuration.engineOptions.maxRuntimeSeconds, 120);
    assert.equal(configuration.engineOptions.principal, principal);
    assert.equal(configuration.engineOptions.allowSubmission, false);
  }
});

test("provider-managed qualification does not invent active reservation ledgers", () => {
  const data = fixture(),
    options = parseQualificationOptions("storage", flags);
  const configuration = validateQualificationConfiguration(
    options,
    data.setupText,
    JSON.stringify({
      ...data.policy,
      usage_mode: "provider_managed",
      daily_seconds: null,
      monthly_seconds: null,
    }),
  );
  assert.equal(configuration.engineOptions.usageMode, "provider_managed");
  assert.equal(
    Object.hasOwn(configuration.engineOptions, "dailySeconds"),
    false,
  );
  assert.equal(
    Object.hasOwn(configuration.engineOptions, "monthlySeconds"),
    false,
  );
});

test("changed setup, runtime, namespace, missing ledgers and unrecognized policy fields refuse locally", () => {
  const data = fixture(),
    options = parseQualificationOptions("storage", flags);
  for (const patch of [
    { setup_sha256: "0".repeat(64) },
    { max_runtime_sec: 100 },
    { usage_mode: "auto" },
    { daily_seconds: null, monthly_seconds: null },
    { daily_seconds: -1 },
    { hidden_allowance_override: 1 },
  ]) {
    assert.throws(
      () =>
        validateQualificationConfiguration(
          options,
          data.setupText,
          JSON.stringify({ ...data.policy, ...patch }),
        ),
      /qualification_/,
    );
  }
  const wrong = JSON.stringify({ ...data.setup, namespace: digest("other") });
  assert.throws(
    () =>
      validateQualificationConfiguration(
        options,
        wrong,
        JSON.stringify({ ...data.policy, setup_sha256: digest(wrong) }),
      ),
    /setup_identity_mismatch/,
  );
});

test("configuration-bound receipts cannot be reused across owner, policy, artifact or legacy boundaries", () => {
  const data = fixture(),
    options = parseQualificationOptions("storage", flags);
  const { identity } = validateQualificationConfiguration(
    options,
    data.setupText,
    data.policyText,
  );
  assert.doesNotThrow(() => assertQualificationReceipt({ identity }, identity));
  assert.throws(
    () =>
      assertQualificationReceipt({ database: data.setup.database }, identity),
    /receipt_identity_mismatch/,
  );
  for (const key of [
    "namespace",
    "source_sha256",
    "requirements_sha256",
    "wheel_sha256",
    "execution_policy_sha256",
    "provider_policy_sha256",
  ]) {
    assert.throws(
      () =>
        assertQualificationReceipt(
          { identity: { ...identity, [key]: "different" } },
          identity,
        ),
      /receipt_identity_mismatch/,
    );
  }
});

test("Exa qualifier reconstructs the reviewed profile instead of downgrading research or changing its fingerprint", () => {
  for (const policy of [
    {
      approvedCostMicrousd: 50000,
      dailyCostMicrousd: 50000,
      secretName: "sourcesql_exa",
      policyVersion: "exa-search.v1",
    },
    {
      approvedCostMicrousd: 1000000,
      dailyCostMicrousd: 5000000,
      secretName: "sourcesql_exa",
      policyVersion: "exa-research.v3",
      model: {
        name: "reviewed-model",
        secretName: "sourcesql_model",
        reasoningEffort: "low",
      },
      embedding: {
        name: "text-embedding-3-small",
        secretName: "sourcesql_embedding",
      },
    },
  ] satisfies HostedExaPolicy[]) {
    const setup = {
      provider_policy: exaDescriptor(policy),
      provider_policy_sha256: exaFingerprint(policy),
      provider_daily_cost_microusd: policy.dailyCostMicrousd,
    };
    assert.deepEqual(qualificationExaPolicy(setup), policy);
    assert.throws(
      () =>
        qualificationExaPolicy({
          ...setup,
          provider_policy_sha256: "0".repeat(64),
        }),
      /fingerprint_mismatch/,
    );
  }
});

test("exact Flight run identities stay strings above JavaScript's safe integer range", () => {
  for (const value of ["1", "9007199254740993", "18446744073709551615"])
    assert.equal(exactFlightRun(value), value);
  for (const value of [
    1,
    9007199254740992,
    "0",
    "01",
    "-1",
    "18446744073709551616",
    "1; SELECT 1",
  ])
    assert.throws(() => exactFlightRun(value), /invalid_flight_run_identity/);
});

for (const [kind, file, extra] of [
  ["storage", "qualify-motherduck.mts", ["--action", "query"]],
  ["app", "qualify-motherduck-app.mts", ["--fixture"]],
  ["exa", "qualify-exa-hosted.mts", ["--action", "submit"]],
] as [Qualifier, string, string[]][]) {
  test(`${file} runs its real CLI offline without credentials, network or receipt writes`, () => {
    const directory = mkdtempSync(
      join(tmpdir(), "sourcesql-qualification-plan-"),
    );
    try {
      const data = fixture(),
        exa: HostedExaPolicy = {
          approvedCostMicrousd: 50000,
          dailyCostMicrousd: 50000,
          secretName: "sourcesql_exa",
          policyVersion: "exa-search.v1",
        };
      const setup =
        kind === "exa"
          ? {
              ...data.setup,
              provider_policy: exaDescriptor(exa),
              provider_policy_sha256: exaFingerprint(exa),
              provider_daily_cost_microusd: exa.dailyCostMicrousd,
            }
          : data.setup;
      const setupText = JSON.stringify(setup),
        setupPath = join(directory, "setup.json"),
        policyPath = join(directory, "policy.json"),
        output = join(directory, "artifacts", "receipt.json");
      writeFileSync(setupPath, setupText);
      writeFileSync(
        policyPath,
        JSON.stringify({ ...data.policy, setup_sha256: digest(setupText) }),
      );
      const guard = join(directory, "deny-network.cjs");
      writeFileSync(
        guard,
        "require('node:net').Socket.prototype.connect = function () { throw Error('qualification_unexpected_network'); };\n",
      );
      const result = spawnSync(
        process.execPath,
        [
          "--require",
          guard,
          "--import",
          "tsx",
          join(root, "scripts", file),
          "--setup",
          setupPath,
          "--policy",
          policyPath,
          "--output",
          output,
          "--principal",
          principal,
          ...extra,
        ],
        {
          cwd: join(root, "apps/research"),
          encoding: "utf8",
          timeout: 20000,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            TSX_DISABLE_CACHE: "1",
            MOTHERDUCK_TOKEN: "",
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      const plan = JSON.parse(result.stdout);
      assert.equal(plan.dry_run, true);
      assert.equal(plan.effects_if_executed.remote_database, true);
      assert.equal(plan.effects_if_executed.flight_submission, kind !== "app");
      assert.equal(existsSync(output), false);
      assert.equal(existsSync(join(directory, "artifacts")), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
