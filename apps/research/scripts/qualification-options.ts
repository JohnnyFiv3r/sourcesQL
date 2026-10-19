/** Offline configuration and effect declaration for explicitly reviewed hosted qualifiers. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  exaDescriptor,
  exaFingerprint,
  type HostedExaPolicy,
} from "../server/hosted-exa.ts";
import type { MotherDuckOptions } from "../server/motherduck.ts";

export type Qualifier = "storage" | "app" | "exa";
export type QualificationOptions = {
  setupPath: string;
  policyPath: string;
  output: string;
  principal: string;
  action: string;
  execute: boolean;
  submit: boolean;
  fixture: boolean;
  discardAck: boolean;
  allowCancel: boolean;
  nativeReceipt?: string;
  job?: string;
};
export type ExecutionPolicy = {
  schema: "sourcesql.qualification-policy.v1";
  setup_sha256: string;
  source_commit: string;
  usage_mode: "operator_reserved" | "provider_managed";
  max_runtime_sec: number;
  daily_seconds: number | null;
  monthly_seconds: number | null;
  monthly_provider_cost_microusd: number | null;
};
const actions = {
  storage: new Set([
    "query",
    "materialize",
    "derived",
    "restore",
    "status",
    "read",
    "logs",
    "cancel-running",
    "summary",
  ]),
  app: new Set(["run"]),
  exa: new Set(["submit", "inspect"]),
};
const dispatchActions = new Set([
  "query",
  "materialize",
  "derived",
  "restore",
  "cancel-running",
  "submit",
]);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const ordered = (value: any): any =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, ordered(value[key])]),
        )
      : value;
export const qualificationDigest = (value: unknown) =>
  hash(JSON.stringify(ordered(value)));
function invalid(code: string): never {
  throw Error(code);
}

export function parseQualificationOptions(
  kind: Qualifier,
  args: string[],
): QualificationOptions {
  const values = new Set([
    "--setup",
    "--policy",
    "--output",
    "--principal",
    "--action",
    "--native-receipt",
    "--job",
  ]);
  const switches = new Set([
    "--execute",
    "--submit",
    "--fixture",
    "--discard-ack",
    "--allow-cancel",
    "--dry-run",
  ]);
  const selected = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if ((!values.has(flag) && !switches.has(flag)) || selected.has(flag))
      invalid("invalid_qualification_arguments");
    if (switches.has(flag)) selected.set(flag, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        invalid("invalid_qualification_arguments");
      selected.set(flag, value);
    }
  }
  const get = (flag: string) =>
    typeof selected.get(flag) === "string"
      ? (selected.get(flag) as string)
      : undefined;
  const required = (flag: string) =>
    get(flag) ??
    invalid("qualification_requires_" + flag.slice(2).replaceAll("-", "_"));
  const principal = required("--principal");
  if (!/^[A-Za-z0-9._@:-]{1,200}$/.test(principal))
    invalid("invalid_qualification_principal");
  const action =
    get("--action") ??
    (kind === "storage" ? "status" : kind === "app" ? "run" : "inspect");
  if (!actions[kind].has(action)) invalid("invalid_qualification_action");
  const execute = selected.has("--execute"),
    submit = selected.has("--submit");
  if (execute && selected.has("--dry-run"))
    invalid("qualification_execution_mode_conflict");
  if (execute && dispatchActions.has(action) && !submit)
    invalid("qualification_submission_requires_submit");
  if (submit && !dispatchActions.has(action))
    invalid("qualification_submit_not_applicable");
  if (selected.has("--allow-cancel") && action !== "cancel-running")
    invalid("qualification_cancel_not_applicable");
  if (execute && action === "cancel-running" && !selected.has("--allow-cancel"))
    invalid("qualification_cancellation_requires_allow_cancel");
  if (
    selected.has("--discard-ack") &&
    (kind !== "storage" || action !== "query")
  )
    invalid("qualification_lost_ack_requires_fixture_query");
  if (selected.has("--fixture") && kind !== "app")
    invalid("qualification_fixture_not_applicable");
  if (get("--native-receipt") && (kind !== "app" || selected.has("--fixture")))
    invalid("qualification_native_receipt_not_applicable");
  if (kind === "app" && !selected.has("--fixture") && !get("--native-receipt"))
    invalid("qualification_requires_native_receipt_or_fixture");
  if (get("--job") && (kind !== "storage" || action !== "status"))
    invalid("qualification_job_not_applicable");
  const output = resolve(required("--output"));
  // Receipts can retain private research; use ignored operator paths, never a source artifact.
  if (
    !output
      .split(/[\\/]/)
      .some((part) => part === "local" || part === "artifacts")
  )
    invalid("qualification_output_requires_private_directory");
  const setupPath = resolve(required("--setup")),
    policyPath = resolve(required("--policy"));
  if (
    !output.endsWith(".json") ||
    [
      setupPath,
      policyPath,
      get("--native-receipt") && resolve(get("--native-receipt")!),
    ].includes(output)
  )
    invalid("qualification_output_must_be_separate_json");
  return {
    setupPath,
    policyPath,
    output,
    principal,
    action,
    execute,
    submit,
    fixture: selected.has("--fixture"),
    discardAck: selected.has("--discard-ack"),
    allowCancel: selected.has("--allow-cancel"),
    ...(get("--native-receipt")
      ? { nativeReceipt: resolve(get("--native-receipt")!) }
      : {}),
    ...(get("--job") ? { job: get("--job") } : {}),
  };
}

export function validateQualificationConfiguration(
  options: QualificationOptions,
  setupText: string,
  policyText: string,
) {
  const setup = JSON.parse(setupText),
    policy = JSON.parse(policyText) as ExecutionPolicy;
  const fields = new Set([
    "schema",
    "setup_sha256",
    "source_commit",
    "usage_mode",
    "max_runtime_sec",
    "daily_seconds",
    "monthly_seconds",
    "monthly_provider_cost_microusd",
  ]);
  if (
    !policy ||
    typeof policy !== "object" ||
    Object.keys(policy).length !== fields.size ||
    Object.keys(policy).some((key) => !fields.has(key)) ||
    policy.schema !== "sourcesql.qualification-policy.v1" ||
    policy.setup_sha256 !== hash(setupText) ||
    !/^[a-f0-9]{40}$/.test(policy.source_commit ?? "")
  )
    invalid("qualification_policy_not_bound_to_setup");
  if (!["operator_reserved", "provider_managed"].includes(policy.usage_mode))
    invalid("qualification_invalid_usage_mode");
  const bound = (value: unknown, min: number, max: number) =>
    Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
  if (
    !bound(policy.max_runtime_sec, 30, 120) ||
    policy.max_runtime_sec !== setup.max_runtime_sec ||
    !(policy.daily_seconds === null || bound(policy.daily_seconds, 0, 86400)) ||
    !(
      policy.monthly_seconds === null ||
      bound(policy.monthly_seconds, 0, 2678400)
    ) ||
    !(
      policy.monthly_provider_cost_microusd === null ||
      bound(policy.monthly_provider_cost_microusd, 0, 1000000000)
    ) ||
    // Reserved mode must name its reviewed ledger instead of silently choosing a default.
    // Provider-managed mode does not enforce these application reservation ledgers.
    (policy.usage_mode === "operator_reserved" &&
      policy.daily_seconds === null &&
      policy.monthly_seconds === null)
  )
    invalid("qualification_invalid_execution_policy");
  const namespace = hash(options.principal);
  if (
    setup.schema !== "sourcesql.hosted-setup.v1" ||
    setup.instance_type !== "F4" ||
    setup.scheduled !== false ||
    setup.namespace !== namespace ||
    setup.storage_schema !== "sourcesql_" + namespace.slice(0, 32) ||
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(setup.database ?? "") ||
    ![
      "pg.us-east-1-aws.motherduck.com",
      "pg.eu-central-1-aws.motherduck.com",
    ].includes(setup.host) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      setup.flight_id ?? "",
    ) ||
    ![
      setup.flight_source_sha256,
      setup.requirements_sha256,
      setup.wheel_sha256,
    ].every((value) => /^[a-f0-9]{64}$/.test(value ?? "")) ||
    (setup.engine_version !== undefined &&
      !/^\d+\.\d+\.\d+$/.test(setup.engine_version))
  )
    invalid("qualification_setup_identity_mismatch");
  const engineOptions = {
    database: setup.database,
    host: setup.host,
    flightId: setup.flight_id,
    principal: options.principal,
    usageMode: policy.usage_mode,
    maxRuntimeSeconds: policy.max_runtime_sec,
    ...(policy.daily_seconds === null
      ? {}
      : { dailySeconds: policy.daily_seconds }),
    ...(policy.monthly_seconds === null
      ? {}
      : { monthlySeconds: policy.monthly_seconds }),
    ...(policy.monthly_provider_cost_microusd === null
      ? {}
      : { monthlyProviderCostMicrousd: policy.monthly_provider_cost_microusd }),
    sourceSha256: setup.flight_source_sha256,
    requirementsSha256: setup.requirements_sha256,
    ...(setup.engine_version ? { engineVersion: setup.engine_version } : {}),
    // Inspect/status never start queued work. Submission requires both explicit switches.
    allowSubmission: options.execute && options.submit,
  } satisfies Omit<MotherDuckOptions, "token">;
  const identity = {
    setup_sha256: hash(setupText),
    source_commit: policy.source_commit,
    execution_policy_sha256: qualificationDigest(policy),
    namespace,
    database: setup.database,
    flight_id: setup.flight_id,
    wheel_sha256: setup.wheel_sha256,
    source_sha256: setup.flight_source_sha256,
    requirements_sha256: setup.requirements_sha256,
    provider_policy_sha256: setup.provider_policy_sha256 ?? null,
    usage_mode: policy.usage_mode,
    max_runtime_sec: policy.max_runtime_sec,
  };
  return { setup, policy, engineOptions, identity };
}

export function loadQualificationConfiguration(options: QualificationOptions) {
  if (!isAbsolute(options.setupPath) || !isAbsolute(options.policyPath))
    invalid("qualification_paths_must_be_absolute");
  return validateQualificationConfiguration(
    options,
    readFileSync(options.setupPath, "utf8"),
    readFileSync(options.policyPath, "utf8"),
  );
}

export function qualificationPlan(
  kind: Qualifier,
  options: QualificationOptions,
  configuration: ReturnType<typeof validateQualificationConfiguration>,
) {
  const flight = dispatchActions.has(options.action);
  return {
    schema: "sourcesql.qualification-plan.v1",
    qualifier: kind,
    action: options.action,
    dry_run: !options.execute,
    identity: configuration.identity,
    receipt: options.output,
    execution_policy: configuration.policy,
    effects_if_executed: {
      remote_database: true,
      database_writes:
        "Initialization may create schema; storage/app actions can persist synthetic state, exact status reads can reconcile terminal outcomes once",
      flight_submission: flight,
      provider_calls:
        kind === "exa" && flight
          ? "one bounded Exa discovery; no fetches or models"
          : 0,
      cancellation:
        options.action === "cancel-running"
          ? "only the job retained by this receipt"
          : false,
      fixture_means_offline: false,
    },
    qualification:
      kind === "app"
        ? "remote storage and in-memory MCP loop; actual host rendering not tested"
        : kind === "exa"
          ? "configured live Exa provider and Flight path; actual host rendering not tested"
          : "bounded fixture Flight and storage; gateway and actual host rendering not tested",
  };
}

export function assertQualificationReceipt(
  receipt: any,
  identity: unknown,
): void {
  if (
    !receipt ||
    !receipt.identity ||
    qualificationDigest(receipt.identity) !== qualificationDigest(identity)
  )
    invalid("qualification_receipt_identity_mismatch_inspect_legacy_handle");
}

export function qualificationExaPolicy(setup: any): HostedExaPolicy {
  const descriptor = setup.provider_policy;
  if (
    !descriptor ||
    !["exa-search.v1", "exa-research.v2", "exa-research.v3"].includes(
      descriptor.version,
    )
  )
    invalid("qualification_requires_reviewed_exa_profile");
  const policy: HostedExaPolicy = {
    approvedCostMicrousd: descriptor.approved_cost_microusd,
    dailyCostMicrousd: setup.provider_daily_cost_microusd,
    secretName: descriptor.secret_name,
    policyVersion: descriptor.version,
    ...(descriptor.model
      ? {
          model: {
            name: descriptor.model.name,
            secretName: descriptor.model.secret_name,
            ...(descriptor.model.reasoning_effort !== undefined
              ? { reasoningEffort: descriptor.model.reasoning_effort }
              : {}),
          },
        }
      : {}),
    ...(descriptor.embedding
      ? {
          embedding: {
            name: descriptor.embedding.name,
            secretName: descriptor.embedding.secret_name,
          },
        }
      : {}),
  };
  if (
    exaFingerprint(policy) !== setup.provider_policy_sha256 ||
    qualificationDigest(exaDescriptor(policy)) !==
      qualificationDigest(descriptor)
  )
    invalid("qualification_exa_profile_fingerprint_mismatch");
  return policy;
}

export function exactFlightRun(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > 18446744073709551615n
  )
    invalid("qualification_invalid_flight_run_identity");
  return value;
}
