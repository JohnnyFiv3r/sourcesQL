// Provision one on-demand Flight. No research job is submitted by this command.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
const require = createRequire(
  new URL("../apps/research/package.json", import.meta.url),
);
const { Client } = require("pg");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";

export function parseArguments(arguments_, environment = process.env) {
  const valueFlags = new Set([
    "--database",
    "--principal",
    "--bundle",
    "--output",
    "--exa-secret",
    "--exa-approved-cost-microusd",
    "--exa-daily-cost-microusd",
    ...["brave", "serper"].flatMap((provider) => [
      `--${provider}-secret`,
      `--${provider}-approved-cost-microusd`,
      `--${provider}-daily-cost-microusd`,
      `--${provider}-request-cost-microusd`,
    ]),
  ]);
  const switches = new Set([
    "--help",
    "--create-database",
    "--use-local-login",
  ]);
  const selected = new Map();
  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index];
    if ((!valueFlags.has(flag) && !switches.has(flag)) || selected.has(flag))
      throw Error("invalid_arguments");
    if (switches.has(flag)) selected.set(flag, true);
    else {
      const value = arguments_[++index];
      if (typeof value !== "string" || !value || value.startsWith("--"))
        throw Error("invalid_arguments");
      selected.set(flag, value);
    }
  }
  if (selected.has("--help")) return { help: true };
  const database = selected.get("--database"),
    principal = selected.get("--principal");
  const host = environment.MOTHERDUCK_HOST ?? "pg.us-east-1-aws.motherduck.com";
  if (
    !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database ?? "") ||
    !/^[A-Za-z0-9._@:-]{1,200}$/.test(principal ?? "") ||
    ![
      "pg.us-east-1-aws.motherduck.com",
      "pg.eu-central-1-aws.motherduck.com",
    ].includes(host)
  )
    throw Error("invalid_configuration");
  let exa;
  const secretName = selected.get("--exa-secret");
  if (secretName !== undefined) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(secretName))
      throw Error("invalid_configuration");
    const integer = (flag, fallback) => {
      const value = selected.get(flag) ?? String(fallback);
      if (!/^[1-9][0-9]{0,6}$/.test(value) || Number(value) > 1_000_000)
        throw Error("invalid_configuration");
      return Number(value);
    };
    const approved = integer("--exa-approved-cost-microusd", 50_000);
    const daily = integer("--exa-daily-cost-microusd", 1_000_000);
    if (daily < approved) throw Error("invalid_configuration");
    const descriptor = {
      approved_cost_microusd: approved,
      search_types: {
        exa: "auto",
        exa_deep: "deep",
        exa_deep_reasoning: "deep-reasoning",
      },
      secret_name: secretName,
      version: "exa-research.v2",
    };
    exa = {
      descriptor,
      providerPolicySha256: hash(JSON.stringify(descriptor)),
      dailyCostMicrousd: daily,
    };
  } else if (
    selected.has("--exa-approved-cost-microusd") ||
    selected.has("--exa-daily-cost-microusd")
  ) {
    throw Error("invalid_configuration");
  }
  let search;
  for (const provider of ["brave", "serper"]) {
    const secret = selected.get(`--${provider}-secret`);
    const costFlags = ["approved", "daily", "request"].map(
      (kind) => `--${provider}-${kind}-cost-microusd`,
    );
    if (secret === undefined) {
      if (costFlags.some((flag) => selected.has(flag)))
        throw Error("invalid_configuration");
      continue;
    }
    if (exa || search || !/^[a-z][a-z0-9_]{0,62}$/.test(secret))
      throw Error("invalid_configuration");
    const integer = (kind, fallback) => {
      const value =
        selected.get(`--${provider}-${kind}-cost-microusd`) ?? fallback;
      if (
        typeof value !== "string" ||
        !/^[1-9][0-9]{0,6}$/.test(value) ||
        Number(value) > 1_000_000
      )
        throw Error("invalid_configuration");
      return Number(value);
    };
    const approved = integer("approved", "50000");
    const daily = integer("daily", "1000000");
    const requestCost = integer("request");
    if (daily < approved || requestCost > approved)
      throw Error("invalid_configuration");
    const descriptor = {
      approved_cost_microusd: approved,
      provider,
      request_cost_microusd: requestCost,
      secret_name: secret,
      version: `${provider}-search.v1`,
    };
    search = {
      descriptor,
      providerPolicySha256: hash(JSON.stringify(descriptor)),
      dailyCostMicrousd: daily,
    };
  }
  return {
    database,
    principal,
    host,
    exa,
    search,
    directory: resolve(selected.get("--bundle") ?? "artifacts/hosted-flight"),
    output: resolve(selected.get("--output") ?? "local/motherduck/setup.json"),
    createDatabase: selected.has("--create-database"),
    useLocalLogin: selected.has("--use-local-login"),
  };
}

function searchSettings(options, includeDaily = false) {
  if (!options.search) return {};
  const { descriptor, dailyCostMicrousd } = options.search;
  const provider = descriptor.provider.toUpperCase();
  return {
    [`SOURCESQL_ALLOW_LIVE_${provider}`]: "1",
    [`SOURCESQL_${provider}_POLICY_VERSION`]: descriptor.version,
    [`SOURCESQL_${provider}_SECRET_NAME`]: descriptor.secret_name,
    [`SOURCESQL_${provider}_APPROVED_COST_MICROUSD`]: String(
      descriptor.approved_cost_microusd,
    ),
    [`SOURCESQL_${provider}_REQUEST_COST_MICROUSD`]: String(
      descriptor.request_cost_microusd,
    ),
    ...(includeDaily
      ? {
          [`SOURCESQL_${provider}_DAILY_COST_MICROUSD`]:
            String(dailyCostMicrousd),
        }
      : {}),
  };
}

export function flightConfiguration(options, namespace, schema) {
  return {
    DATABASE: options.database,
    STORAGE_SCHEMA: schema,
    NAMESPACE: namespace,
    JOB_ID: "unsubmitted",
    SOURCESQL_MOTHERDUCK_PG_HOST: options.host,
    ...searchSettings(options),
    ...(options.exa
      ? {
          SOURCESQL_ALLOW_LIVE_EXA: "1",
          SOURCESQL_EXA_POLICY_VERSION: options.exa.descriptor.version,
          SOURCESQL_EXA_SECRET_NAME: options.exa.descriptor.secret_name,
          SOURCESQL_EXA_APPROVED_COST_MICROUSD: String(
            options.exa.descriptor.approved_cost_microusd,
          ),
        }
      : {}),
  };
}

export function flightSQL(
  options,
  name,
  source,
  requirements,
  namespace,
  schema,
) {
  const config = flightConfiguration(options, namespace, schema);
  return `SELECT CAST(flight_id AS VARCHAR) AS flight_id,current_version FROM md_create_flight(
    name := ${literal(name)},source_code := ${literal(source)},requirements_txt := ${literal(requirements)},
    config := MAP {${Object.entries(config)
      .map(([key, value]) => `${literal(key)}: ${literal(value)}`)
      .join(",")}},
    ${options.exa || options.search ? `flight_secret_names := [${literal((options.exa ?? options.search).descriptor.secret_name)}],` : ""}
    instance_type := 'F4',max_runtime_sec := 120)`;
}

export function outputSettings(options, receipt) {
  return {
    SOURCESQL_BACKEND: "motherduck",
    MOTHERDUCK_DB: options.database,
    MOTHERDUCK_HOST: options.host,
    SOURCESQL_PRINCIPAL: options.principal,
    SOURCESQL_FLIGHT_ID: receipt.flight_id,
    SOURCESQL_FLIGHT_SOURCE_SHA256: receipt.flight_source_sha256,
    SOURCESQL_FLIGHT_REQUIREMENTS_SHA256: receipt.requirements_sha256,
    SOURCESQL_ALLOW_FLIGHT_SUBMISSION: "0",
    SOURCESQL_FLIGHT_MAX_RUNTIME_SEC: "120",
    SOURCESQL_FLIGHT_DAILY_SECONDS: "600",
    ...searchSettings(options, true),
    ...(options.exa
      ? {
          SOURCESQL_ALLOW_LIVE_EXA: "1",
          SOURCESQL_EXA_POLICY_VERSION: options.exa.descriptor.version,
          SOURCESQL_EXA_SECRET_NAME: options.exa.descriptor.secret_name,
          SOURCESQL_EXA_APPROVED_COST_MICROUSD: String(
            options.exa.descriptor.approved_cost_microusd,
          ),
          SOURCESQL_EXA_DAILY_COST_MICROUSD: String(
            options.exa.dailyCostMicrousd,
          ),
        }
      : {}),
  };
}

export function isRetryableFlightReceipt(receipt) {
  return (
    receipt?.schema === "sourcesql.hosted-setup.v1" &&
    receipt.phase === "prepared" &&
    receipt.flight_creation_attempted === false &&
    !Object.hasOwn(receipt, "flight_name") &&
    !Object.hasOwn(receipt, "flight_id")
  );
}

export async function main(arguments_ = process.argv.slice(2)) {
  let client, receiptLock, lockPath;
  try {
    const options = parseArguments(arguments_);
    if (options.help) {
      console.log(
        "Usage: node hosted/setup.mjs --database NAME --principal OWNER_ID [--bundle artifacts/hosted-flight] [--output local/motherduck/setup.json] [--create-database] [--use-local-login] [--exa-secret NAME] [--exa-approved-cost-microusd 50000] [--exa-daily-cost-microusd 1000000] [--brave-secret NAME --brave-request-cost-microusd N | --serper-secret NAME --serper-request-cost-microusd N] [--PROVIDER-approved-cost-microusd 50000] [--PROVIDER-daily-cost-microusd 1000000]",
      );
      console.log(
        "Uses MOTHERDUCK_TOKEN, or explicitly chosen local CLI login. Creates one unscheduled F4/120s Flight; submits no jobs. Optional search flags bind one existing Flight secret by name. Brave/Serper require an operator-set conservative request cost estimate; provider billing is unavailable. Saves token-free settings with submission disabled.",
      );
      return;
    }
    const { database, principal, host, directory, output } = options;
    mkdirSync(dirname(output), { recursive: true });
    lockPath = output + ".lock";
    try {
      receiptLock = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST")
        throw Error("setup_already_running_or_interrupted_inspect_lock");
      throw error;
    }
    let previous;
    if (existsSync(output)) {
      try {
        previous = JSON.parse(readFileSync(output, "utf8"));
      } catch {
        throw Error("setup_already_attempted_inspect_saved_receipt");
      }
      if (!isRetryableFlightReceipt(previous))
        throw Error("setup_already_attempted_inspect_saved_receipt");
    }
    let token = process.env.MOTHERDUCK_TOKEN;
    if (!token && options.useLocalLogin)
      token = JSON.parse(
        readFileSync(`${homedir()}/.motherduck/credentials.json`, "utf8"),
      ).motherduck_token;
    if (!token) throw Error("configure_token_or_choose_local_login");
    const manifest = JSON.parse(
      readFileSync(resolve(directory, "manifest.json"), "utf8"),
    );
    const source = readFileSync(resolve(directory, "flight.py"), "utf8");
    const requirements = readFileSync(
      resolve(directory, "requirements.txt"),
      "utf8",
    );
    if (
      hash(source) !== manifest.flight_source_sha256 ||
      hash(requirements) !== manifest.requirements_sha256 ||
      Buffer.byteLength(source) > 200000 ||
      Buffer.byteLength(requirements) > 20000 ||
      manifest.credentials_embedded !== false
    )
      throw Error("bundle_integrity");
    const namespace = hash(principal),
      schema = "sourcesql_" + namespace.slice(0, 32);
    const receipt = {
      schema: "sourcesql.hosted-setup.v1",
      database,
      host,
      namespace,
      storage_schema: schema,
      creation_attempted_at: new Date().toISOString(),
      flight_source_sha256: manifest.flight_source_sha256,
      requirements_sha256: manifest.requirements_sha256,
      wheel_sha256: manifest.wheel_sha256,
      instance_type: "F4",
      max_runtime_sec: 120,
      scheduled: false,
      jobs_submitted: 0,
      ...(options.exa || options.search
        ? {
            provider_policy: (options.exa ?? options.search).descriptor,
            provider_policy_sha256: (options.exa ?? options.search)
              .providerPolicySha256,
            provider_daily_cost_microusd: (options.exa ?? options.search)
              .dailyCostMicrousd,
          }
        : {}),
    };
    if (previous) {
      const {
        creation_attempted_at,
        phase,
        flight_creation_attempted,
        ...priorConfiguration
      } = previous;
      const { creation_attempted_at: currentTime, ...currentConfiguration } =
        receipt;
      if (
        JSON.stringify(priorConfiguration) !==
        JSON.stringify(currentConfiguration)
      )
        throw Error("setup_retry_configuration_changed");
      receipt.creation_attempted_at = creation_attempted_at;
    }
    receipt.phase = "prepared";
    receipt.flight_creation_attempted = false;
    let saved = previous !== undefined;
    const save = () => {
      writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", {
        mode: 0o600,
        flag: saved ? "w" : "wx",
      });
      saved = true;
    };
    save(); // A connection/database failure is safely retryable before Flight creation.
    client = new Client({
      host,
      port: 5432,
      user: "user",
      password: token,
      database: options.createDatabase ? "my_db" : database,
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 15000,
      query_timeout: 30000,
    });
    await client.connect();
    if (options.createDatabase)
      await client.query(`CREATE DATABASE IF NOT EXISTS "${database}"`);
    const name = "sourcesql_" + namespace.slice(0, 12) + "_" + Date.now();
    receipt.flight_name = name;
    receipt.phase = "creating";
    receipt.flight_creation_attempted = true;
    save(); // Persist the uncertainty fence before the platform can create a Flight.
    const rows = (
      await client.query(
        flightSQL(options, name, source, requirements, namespace, schema),
      )
    ).rows;
    if (rows.length !== 1 || !/^[a-f0-9-]{36}$/.test(rows[0].flight_id))
      throw Error("uncertain_creation_inspect_receipt");
    Object.assign(receipt, rows[0], { phase: "created" });
    save();
    const settings = outputSettings(options, receipt);
    writeFileSync(
      output + ".env",
      Object.entries(settings)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        provisioned: true,
        receipt: output,
        settings: output + ".env",
        jobs_submitted: 0,
        token_saved: false,
      }),
    );
  } catch (error) {
    // Remote SQL errors can include source/config. Never print those details.
    const known = new Set([
      "invalid_arguments",
      "invalid_configuration",
      "setup_already_attempted_inspect_saved_receipt",
      "setup_already_running_or_interrupted_inspect_lock",
      "setup_retry_configuration_changed",
      "configure_token_or_choose_local_login",
      "bundle_integrity",
      "uncertain_creation_inspect_receipt",
    ]);
    console.error(
      JSON.stringify({
        provisioned: false,
        error_type: error.name,
        reason:
          error.code === "EEXIST"
            ? "setup_already_attempted_inspect_saved_receipt"
            : known.has(error.message)
              ? error.message
              : "remote_operation_failed",
        inspect_receipt_before_retrying: true,
      }),
    );
    process.exitCode = 1;
  } finally {
    await client?.end().catch(() => undefined);
    if (receiptLock !== undefined) {
      closeSync(receiptLock);
      unlinkSync(lockPath);
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
