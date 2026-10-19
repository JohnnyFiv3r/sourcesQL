/** Native Postgres gateway: durable owner storage, on-demand Flight jobs, no Python bridge. */
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import type { ResearchEngine, EngineResult } from "./engine.js";
import type { ResearchState, ResearchStateBackend } from "./store.js";
import {
  exaSearchTypes,
  exaResearchLimits,
  exaOperators,
  exaConfiguration,
  exaDeadline,
  isExaProfile,
  exaBudgets,
  exaFingerprint,
  validateExaPolicy,
  type HostedExaPolicy,
} from "./hosted-exa.js";
import { tableDefinitions, tableMigrations } from "./motherduck-schema.js";
import type { HostedResearchOptions } from "./hosted-research.js";
import {
  isHostedSearchProfile,
  HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS,
  validateHostedSearchPolicy,
  hostedSearchFingerprint,
  hostedSearchBudgets,
  hostedSearchConfiguration,
  hostedSearchOperators,
  isHostedSearchResearch,
  type HostedSearchPolicy,
} from "./hosted-search.js";

import type { ResearchCapacity } from "../src/job-view.js";
import { capacitySchema } from "../src/job-view.js";
import {
  summarizeUsage,
  allowanceNotices,
  usageWindow,
  type FlightUsage,
  type UsageWindow,
} from "./usage.js";
import { safeExecutionError, safeFailureContext } from "./execution-errors.js";

type Row = Record<string, any>;
export interface SqlClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
type SqlConnection = Pick<SqlClient, "query">;
export interface SqlPoolClient extends SqlConnection {
  release(error?: Error | boolean): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}
export interface SqlPool {
  connect(): Promise<SqlPoolClient>;
  on(event: "error", listener: (error: Error) => void): unknown;
}
export type MotherDuckOptions = {
  database: string;
  host: string;
  token: string;
  flightId: string;
  principal: string;
  allowSubmission?: boolean;
  usageMode?: "provider_managed" | "operator_reserved";
  maxRuntimeSeconds?: number;
  dailySeconds?: number;
  monthlySeconds?: number;
  monthlyProviderCostMicrousd?: number;
  sourceSha256?: string;
  engineVersion?: string;
  requirementsSha256?: string;
  exa?: HostedExaPolicy;
  search?: HostedSearchPolicy;
  clientFactory?: () => SqlClient;
  poolFactory?: (configuration: PoolConfig) => SqlPool;
};
function livePolicyFingerprint(options: MotherDuckOptions): string | null {
  return options.exa
    ? exaFingerprint(options.exa)
    : options.search
      ? hostedSearchFingerprint(options.search)
      : null;
}
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const resultPattern = /^[A-Za-z0-9_-]{1,100}$/;
const terminal = new Set(["completed", "failed", "cancelled"]);
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const stamp = () => new Date().toISOString();
function stable(value: any): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return (
      "{" +
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stable(value[key]))
        .join(",") +
      "}"
    );
  }
  throw new BackendError(
    "invalid_request",
    "Request contains unsupported values",
  );
}
export class BackendError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}
function identity(value: unknown, pattern = uuidPattern): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new BackendError("invalid_request", "Invalid identity");
  return pattern === uuidPattern ? value.toLowerCase() : value;
}
function bounded(value: unknown, minimum: number, maximum: number): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new BackendError(
      "invalid_request",
      "Value exceeds the configured limit",
    );
  return Number(value);
}
const runColumns = `CAST(run_id AS VARCHAR) AS run_id,CAST(flight_id AS VARCHAR) AS flight_id,
  flight_version,CAST(run_number AS VARCHAR) AS run_number,status,exit_code,CAST(config AS JSON)::VARCHAR AS config_json,
  CAST(started_at AS VARCHAR) AS started_at,CAST(ended_at AS VARCHAR) AS ended_at,epoch(ended_at-started_at) AS elapsed_seconds`;

export class MotherDuckEngine implements ResearchEngine {
  readonly supportsExplain = true;
  readonly supportsAsyncJobs = true;
  readonly supportsUsageReporting = true;
  readonly usageMode: "provider_managed" | "operator_reserved";
  readonly namespace: string;
  readonly schema: string;
  readonly maxRuntime: number;
  readonly dailySeconds?: number;
  readonly monthlySeconds?: number;
  readonly monthlyProviderCostMicrousd?: number;
  private readonly connectClient?: () => SqlClient;
  private readonly pool?: SqlPool;
  constructor(readonly options: MotherDuckOptions) {
    if (
      options.usageMode !== undefined &&
      !["provider_managed", "operator_reserved"].includes(options.usageMode)
    )
      throw new BackendError("invalid_request", "Invalid usage mode");
    // Existing deployments retain their explicit safeguards until their reviewed plan opts in.
    this.usageMode = options.usageMode ?? "operator_reserved";
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(options.database) ||
      !new Set([
        "pg.us-east-1-aws.motherduck.com",
        "pg.eu-central-1-aws.motherduck.com",
      ]).has(options.host) ||
      !options.token ||
      !options.principal ||
      options.principal.length > 200
    )
      throw new BackendError(
        "invalid_request",
        "Invalid configured MotherDuck backend",
      );
    options.flightId = identity(options.flightId);
    if (
      options.allowSubmission &&
      (!/^[a-f0-9]{64}$/.test(options.sourceSha256 ?? "") ||
        !/^[a-f0-9]{64}$/.test(options.requirementsSha256 ?? ""))
    )
      throw new BackendError(
        "invalid_request",
        "Flight submission requires the reviewed source and requirements fingerprints",
      );
    if (
      options.engineVersion !== undefined &&
      (!/^\d+\.\d+\.\d+$/.test(options.engineVersion) ||
        !/^[a-f0-9]{64}$/.test(options.sourceSha256 ?? "") ||
        !/^[a-f0-9]{64}$/.test(options.requirementsSha256 ?? ""))
    )
      throw new BackendError(
        "invalid_request",
        "A configured worker version requires its reviewed source and requirements fingerprints",
      );
    if (options.exa && options.search)
      throw new BackendError(
        "invalid_request",
        "Choose one live search provider per Flight",
      );
    if (options.exa) validateExaPolicy(options.exa);
    if (options.search) validateHostedSearchPolicy(options.search);
    this.namespace = digest(options.principal);
    this.schema = "sourcesql_" + this.namespace.slice(0, 32);
    this.maxRuntime = bounded(options.maxRuntimeSeconds ?? 120, 30, 120);
    this.monthlySeconds =
      options.monthlySeconds === undefined
        ? undefined
        : bounded(options.monthlySeconds, 0, 2_678_400);
    this.monthlyProviderCostMicrousd =
      options.monthlyProviderCostMicrousd === undefined
        ? undefined
        : bounded(options.monthlyProviderCostMicrousd, 0, 1_000_000_000);
    this.dailySeconds =
      options.dailySeconds === undefined && this.monthlySeconds !== undefined
        ? undefined
        : bounded(options.dailySeconds ?? 600, 0, 86_400);
    this.connectClient = options.clientFactory;
    if (!this.connectClient) {
      this.pool = (
        options.poolFactory ?? ((configuration) => new Pool(configuration))
      )({
        host: options.host,
        database: options.database,
        port: 5432,
        user: "user",
        password: options.token,
        ssl: { rejectUnauthorized: true },
        connectionTimeoutMillis: 15000,
        query_timeout: 15000,
        max: 3,
        idleTimeoutMillis: 5000,
        allowExitOnIdle: true,
      });
      // pg removes a failed idle client before emitting this event. Handling it
      // prevents an idle socket error from crashing the server or logging secrets.
      this.pool.on("error", () => {});
    }
  }
  table(name: string): string {
    return `"${this.schema}"."${name}"`;
  }
  async connection<T>(work: (client: SqlConnection) => Promise<T>): Promise<T> {
    let direct: SqlClient | undefined;
    let pooled: SqlPoolClient | undefined;
    let discard = false;
    const onLeaseError = () => {
      discard = true;
    };
    try {
      let client: SqlConnection;
      if (this.connectClient) {
        direct = this.connectClient();
        await direct.connect();
        client = direct;
      } else {
        pooled = await this.pool!.connect();
        pooled.on("error", onLeaseError);
        client = pooled;
      }
      return await work({
        query: async (sql, values) => {
          try {
            return await client.query(sql, values);
          } catch (error) {
            // Even if work handles a query/rollback error, do not reuse a
            // potentially aborted transaction or timed-out protocol connection.
            discard = true;
            throw error;
          }
        },
      });
    } catch (error) {
      discard = true;
      if (error instanceof BackendError) throw error;
      const code = (error as { code?: string })?.code;
      throw new BackendError(
        code === "40001" ? "storage_conflict" : "storage_unavailable",
        "MotherDuck storage operation failed safely",
      );
    } finally {
      if (direct) await direct.end().catch(() => undefined);
      if (pooled) {
        pooled.removeListener("error", onLeaseError);
        pooled.release(discard);
      }
    }
  }
  async transaction<T>(
    write: boolean,
    work: (client: SqlConnection) => Promise<T>,
  ): Promise<T> {
    return this.connection(async (client) => {
      await client.query("BEGIN TRANSACTION");
      try {
        if (write)
          await client.query(
            `UPDATE ${this.table("control")} SET revision=revision+1 WHERE id=1`,
          );
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    });
  }
  async initialize(): Promise<void> {
    await this.connection(async (client) => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      for (const definition of tableDefinitions) {
        await client.query(
          definition.replace(
            /(EXISTS\s+)([a-z_]+)/,
            (_match, prefix, name) => prefix + this.table(name),
          ),
        );
      }
      for (const migration of tableMigrations)
        await client.query(
          migration.replace(
            /^ALTER TABLE jobs /,
            `ALTER TABLE ${this.table("jobs")} `,
          ),
        );
      await client.query(
        `INSERT OR IGNORE INTO ${this.table("control")} VALUES(1,$1,0)`,
        [this.namespace],
      );
      const row = (
        await client.query(
          `SELECT namespace FROM ${this.table("control")} WHERE id=1`,
        )
      ).rows[0];
      if (row?.namespace !== this.namespace)
        throw new BackendError("unauthorized", "Storage owner mismatch");
    });
  }
  private async resultRecord(
    client: SqlConnection,
    id: string,
    seen = new Set<string>(),
    cache = new Map<string, Row>(),
  ): Promise<Row> {
    identity(id, resultPattern);
    if (seen.has(id) || seen.size >= 64)
      throw new BackendError(
        "evidence_invalid",
        "Invalid result dependency graph",
      );
    const cached = cache.get(id);
    if (cached) return cached;
    if (cache.size >= 64)
      throw new BackendError(
        "evidence_invalid",
        "Result dependency graph exceeds allowance",
      );
    const next = new Set(seen).add(id);
    const row = (
      await client.query(
        `SELECT hash,metadata,revoked,payload,wire_payload,wire_hash FROM ${this.table("results")} WHERE id=$1`,
        [id],
      )
    ).rows[0];
    if (!row || Number(row.revoked))
      throw new BackendError(
        "unauthorized",
        "Result or dependency unavailable",
      );
    if (
      digest(row.payload) !== row.hash ||
      digest(row.wire_payload) !== row.wire_hash
    )
      throw new BackendError(
        "evidence_invalid",
        "Retained result integrity failure",
      );
    const metadata = JSON.parse(row.metadata);
    if (
      metadata.result_id !== id ||
      metadata.content_sha256 !== row.hash ||
      !Array.isArray(metadata.parents ?? [])
    )
      throw new BackendError(
        "evidence_invalid",
        "Retained result metadata mismatch",
      );
    if (
      ["private_local", "private_derived"].includes(
        metadata.data_classification,
      )
    )
      throw new BackendError(
        "unauthorized",
        "Hosted private data is not enabled",
      );
    for (const parent of metadata.parents ?? []) {
      const ancestor = await this.resultRecord(
        client,
        parent.result_id,
        next,
        cache,
      );
      if (parent.content_sha256 && parent.content_sha256 !== ancestor.hash)
        throw new BackendError(
          "evidence_invalid",
          "Result dependency pin mismatch",
        );
    }
    if (cache.size >= 64)
      throw new BackendError(
        "evidence_invalid",
        "Result dependency graph exceeds allowance",
      );
    const authorized = { ...row, parsed: metadata };
    cache.set(id, authorized);
    return authorized;
  }
  async readResult(params: Row): Promise<EngineResult> {
    const id = identity(params.result_id, resultPattern);
    const offset = bounded(params.offset ?? 0, 0, 1000000),
      limit = bounded(params.limit ?? 100, 0, 1000);
    return this.transaction(false, async (client) => {
      const record = await this.resultRecord(client, id);
      const table = JSON.parse(record.wire_payload),
        metadata = record.parsed;
      if (
        !Array.isArray(table.columns) ||
        !Array.isArray(table.rows) ||
        table.rows.length !== metadata.row_count ||
        !Array.isArray(metadata.row_ids) ||
        metadata.row_ids.length !== table.rows.length
      )
        throw new BackendError(
          "evidence_invalid",
          "Retained result shape mismatch",
        );
      const columns =
        params.columns === undefined
          ? table.columns
          : table.columns.filter((c: Row) => params.columns.includes(c.key));
      if (
        params.columns !== undefined &&
        (!Array.isArray(params.columns) ||
          columns.length !== params.columns.length)
      )
        throw new BackendError(
          "invalid_request",
          "Unknown selected result column",
        );
      let latest = metadata.receipt;
      if (metadata.run_id) {
        const run = (
          await client.query(
            `SELECT receipt FROM ${this.table("runs")} WHERE id=$1`,
            [metadata.run_id],
          )
        ).rows[0];
        if (!run)
          throw new BackendError(
            "evidence_invalid",
            "Retained receipt unavailable",
          );
        latest = JSON.parse(run.receipt);
      }
      return {
        ...metadata,
        columns,
        rows: table.rows
          .slice(offset, offset + limit)
          .map((row: Row) =>
            Object.fromEntries(columns.map((c: Row) => [c.key, row[c.key]])),
          ),
        row_ids: metadata.row_ids.slice(offset, offset + limit),
        offset,
        next_offset: offset + limit < table.rows.length ? offset + limit : null,
        latest_receipt: latest,
        source_versions: metadata.source_versions ?? [],
        evidence: metadata.evidence ?? [],
      };
    });
  }
  private async getJob(client: SqlConnection, id: string): Promise<Row> {
    const row = (
      await client.query(
        `SELECT CAST(id AS VARCHAR) AS id,CAST(request_id AS VARCHAR) AS request_id,
      operation,status,created_at,updated_at,CAST(flight_id AS VARCHAR) AS flight_id,flight_version,
      CAST(flight_run_id AS VARCHAR) AS flight_run_id,CAST(flight_run_number AS VARCHAR) AS flight_run_number,
      CAST(claim_token AS VARCHAR) AS claim_token,engine_run_id,result_id,cancel_requested,error_code,output_json,dispatch_intent_at,flight_settled,flight_invalid,provider_policy_sha256,provider_cost_reserved_microusd,request_json
      FROM ${this.table("jobs")} WHERE id=$1::UUID`,
        [identity(id)],
      )
    ).rows[0];
    if (!row) throw new BackendError("not_found", "Job unavailable");
    return row;
  }
  private envelope(job: Row): Row {
    const error = safeExecutionError(job.error_code);
    return {
      job_id: job.id,
      operation: job.operation,
      request_id: job.request_id,
      status: job.status,
      pending:
        !terminal.has(job.status) ||
        (job.status === "cancelled" &&
          !!job.dispatch_intent_at &&
          !job.flight_settled),
      cancellation_requested: !!job.cancel_requested,
      created_at: job.created_at,
      updated_at: job.updated_at,
      ...(job.status === "completed" && job.operation !== "explain"
        ? { result_id: job.result_id, run_id: job.engine_run_id }
        : {}),
      ...(job.status === "completed" && job.operation === "explain"
        ? { preflight: JSON.parse(job.output_json) }
        : {}),
      ...(job.status === "failed"
        ? {
            error_code: error.code,
            ...(job.engine_run_id ? { run_id: job.engine_run_id } : {}),
            error,
            ...safeFailureContext(
              job.output_json ? JSON.parse(job.output_json) : {},
            ),
          }
        : {}),
    };
  }
  private async authorizeCompletedJob(job: Row): Promise<void> {
    if (job.operation !== "explain") {
      await this.readResult({ result_id: job.result_id, limit: 0 });
      return;
    }
    const explanation = JSON.parse(job.output_json);
    await this.transaction(false, async (client) => {
      for (const pin of explanation.input_pins ?? [])
        await this.resultRecord(client, pin.result_id);
    });
  }
  private async recordFlightUsage(client: SqlConnection, job: Row, run: Row) {
    const seconds = Number(run.elapsed_seconds);
    if (
      !run.started_at ||
      !run.ended_at ||
      !Number.isFinite(seconds) ||
      seconds < 0 ||
      !Number.isFinite(Date.parse(run.started_at)) ||
      !Number.isFinite(Date.parse(run.ended_at))
    )
      return;
    await client.query(
      `INSERT OR IGNORE INTO ${this.table("usage_flights")} VALUES($1,$2::UUID,$3,$4,$5::DOUBLE,'F4')`,
      [
        run.run_id,
        job.id,
        new Date(run.started_at).toISOString(),
        new Date(run.ended_at).toISOString(),
        seconds,
      ],
    );
  }

  private async usageData(
    client: SqlConnection,
    window: UsageWindow,
    job?: Row,
  ) {
    // Project metering fields only. Prompts, result rows and provider messages stay private.
    const rows = (
      await client.query(
        `SELECT id AS run_id,json_extract_string(receipt,'$.started_at') AS started_at,
        CAST(json_extract(receipt,'$.provider_events') AS VARCHAR) AS events_json
        FROM ${this.table("runs")} WHERE CAST(json_extract_string(receipt,'$.started_at') AS TIMESTAMPTZ) >= $1::TIMESTAMPTZ
        AND CAST(json_extract_string(receipt,'$.started_at') AS TIMESTAMPTZ) < $2::TIMESTAMPTZ${job ? " AND id=$3" : ""}`,
        [window.start, window.end, ...(job ? [job.engine_run_id ?? ""] : [])],
      )
    ).rows;
    const flights = (
      await client.query(
        `SELECT run_id,CAST(job_id AS VARCHAR) AS job_id,started_at,ended_at,elapsed_seconds,instance_type
        FROM ${this.table("usage_flights")} WHERE started_at >= $1 AND started_at < $2${job ? " AND job_id=$3::UUID" : ""}`,
        [window.start, window.end, ...(job ? [job.id] : [])],
      )
    ).rows as FlightUsage[];
    return {
      receipts: rows.map((row) => ({
        ...row,
        events: JSON.parse(row.events_json ?? "[]"),
      })),
      flights,
    };
  }

  async usageReport(params: Row = {}): Promise<Row> {
    if (
      Object.keys(params).some(
        (key) => !["start", "end", "job_id"].includes(key),
      )
    )
      throw new BackendError("invalid_request", "Invalid usage interval");
    let window;
    try {
      window = usageWindow(params);
    } catch {
      throw new BackendError(
        "invalid_request",
        "Choose an ISO date/time interval of at most 366 days",
      );
    }
    if (params.job_id !== undefined) identity(params.job_id);
    // A worker can publish before its Flight exits. Observe finished platform runs
    // without resubmission; missing/older observations stay explicitly unknown.
    await this.observeUsage(window.start, window.end, params.job_id).catch(
      () => undefined,
    );
    return this.transaction(false, async (client) => {
      const job = params.job_id
        ? await this.getJob(client, identity(params.job_id))
        : undefined;
      const { receipts, flights } = await this.usageData(client, window, job);
      const unresolved = (
        await client.query(
          `SELECT count(*)::INTEGER AS count FROM ${this.table("jobs")} j
        WHERE dispatch_intent_at IS NOT NULL AND created_at >= $1 AND created_at < $2
        AND NOT EXISTS(SELECT 1 FROM ${this.table("usage_flights")} f WHERE f.job_id=j.id)${job ? " AND j.id=$3::UUID" : ""}`,
          [window.start, window.end, ...(job ? [job.id] : [])],
        )
      ).rows[0];
      return {
        ...summarizeUsage(receipts, flights, window, this.options.host),
        usage_mode: this.usageMode,
        unobserved_flight_jobs: Number(unresolved.count),
        ...(job ? { job_id: job.id } : {}),
      };
    });
  }

  private async observeUsage(start: string, end: string, jobId?: string) {
    const jobs = await this.connection(
      async (client) =>
        (
          await client.query(
            `SELECT CAST(id AS VARCHAR) AS id,CAST(flight_run_id AS VARCHAR) AS flight_run_id,flight_version
      FROM ${this.table("jobs")} j WHERE dispatch_intent_at IS NOT NULL
      AND created_at >= $1 AND created_at < $2 AND flight_run_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM ${this.table("usage_flights")} f WHERE f.job_id=j.id)
      ${jobId ? "AND id=$3::UUID" : ""} ORDER BY created_at DESC LIMIT 100`,
            [start, end, ...(jobId ? [jobId] : [])],
          )
        ).rows,
    );
    if (!jobs.length) return;
    const runs = await this.connection(
      async (client) =>
        (
          await client.query(
            `SELECT ${runColumns} FROM md_list_flight_runs(flight_id := '${this.options.flightId}'::UUID,"LIMIT" := 100)`,
          )
        ).rows,
    );
    const observations: { job: Row; run: Row }[] = [];
    for (const run of runs) {
      const job = jobs.find((job) => job.flight_run_id === run.run_id);
      if (
        !job ||
        !["SUCCEEDED", "FAILED", "CANCELLED"].includes(
          String(run.status).replace(/^RUN_STATUS_/, ""),
        )
      )
        continue;
      const config = JSON.parse(run.config_json);
      if (
        run.flight_id !== this.options.flightId ||
        Number(run.flight_version) !== Number(job.flight_version) ||
        config.JOB_ID !== job.id ||
        config.NAMESPACE !== this.namespace ||
        config.STORAGE_SCHEMA !== this.schema ||
        config.DATABASE !== this.options.database
      )
        continue;
      observations.push({ job, run });
    }
    if (observations.length)
      await this.transaction(true, async (client) => {
        for (const { job, run } of observations)
          await this.recordFlightUsage(client, job, run);
      });
  }

  async usageNotices() {
    const now = new Date(),
      start = now.toISOString().slice(0, 10) + "T00:00:00.000Z";
    const month = usageWindow({}, now);
    const today = usageWindow({
      start,
      end: new Date(Date.parse(start) + 86400000).toISOString(),
    });
    // The daily window is contained in this UTC month. Observe native metadata
    // once, then summarize both notices from the same owner-scoped snapshot.
    await this.observeUsage(month.start, month.end).catch(() => undefined);
    return this.transaction(false, async (client) => {
      const { receipts, flights } = await this.usageData(client, month);
      const notices = allowanceNotices(
        summarizeUsage(receipts, flights, month, this.options.host),
        summarizeUsage(receipts, flights, today, this.options.host),
      );
      if (!notices.length) return [];
      const dismissed = (
        await client.query(
          `SELECT id FROM ${this.table("usage_notice_dismissals")} WHERE id IN (${notices.map((_, i) => `$${i + 1}`).join(",")})`,
          notices.map((n) => n.id),
        )
      ).rows;
      return notices.filter(
        (notice) => !dismissed.some((row) => row.id === notice.id),
      );
    });
  }

  private async providerCapacity(
    job: Row,
  ): Promise<ResearchCapacity | undefined> {
    if (job.status !== "failed" || !job.engine_run_id) return;
    return this.transaction(false, async (client) => {
      const row = (
        await client.query(
          `SELECT CAST(json_extract(receipt,'$.provider_events') AS VARCHAR) AS events_json FROM ${this.table("runs")} WHERE id=$1`,
          [job.engine_run_id],
        )
      ).rows[0];
      const events = JSON.parse(row?.events_json ?? "[]");
      for (const event of [...events].reverse()) {
        const parsed = capacitySchema.safeParse(event.provider_capacity);
        if (parsed.success && parsed.data.reason === "provider_limit")
          return parsed.data;
      }
    });
  }
  /** Existing daily rows also govern calendar-month reservations, including pre-upgrade work. */
  private async capacityForJob(
    client: SqlConnection,
    job: Row,
    now = new Date(),
  ): Promise<ResearchCapacity | undefined> {
    if (this.usageMode === "provider_managed") return undefined;
    const day = now.toISOString().slice(0, 10);
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    )
      .toISOString()
      .slice(0, 10);
    const monthEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();
    const dayEnd = new Date(
      Date.parse(`${day}T00:00:00Z`) + 86400000,
    ).toISOString();
    const reserved = async (
      table: string,
      column: string,
      period: "day" | "month",
    ) => {
      const row = (
        await client.query(
          `SELECT CAST(coalesce(sum(${column}),0) AS VARCHAR) AS used FROM ${this.table(table)} WHERE day >= $1 AND day < $2`,
          period === "month"
            ? [monthStart, monthEnd.slice(0, 10)]
            : [day, dayEnd.slice(0, 10)],
        )
      ).rows[0];
      return Number(row.used);
    };
    for (const [period, limit] of [
      ["month", this.monthlySeconds],
      ["day", this.dailySeconds],
    ] as const) {
      if (limit === undefined) continue;
      const used = await reserved(
        "flight_allowances",
        "reserved_seconds",
        period,
      );
      if (used + this.maxRuntime > limit)
        return {
          resource: "flight_compute",
          reason: "operator_limit",
          allowance: "configured",
          period,
          resets_at: period === "month" ? monthEnd : dayEnd,
          services: ["motherduck"],
          limit,
          used,
          unit: "seconds",
        };
    }
    const policy = this.options.exa ?? this.options.search;
    if (job.operation === "query" && job.provider_policy_sha256 && policy) {
      const cost = Number(
        JSON.parse(job.request_json).budgets?.max_cost_microusd,
      );
      const services: NonNullable<ResearchCapacity["services"]> = this.options
        .exa
        ? [
            "exa",
            ...(this.options.exa.model || this.options.exa.embedding
              ? ["openai" as const]
              : []),
          ]
        : [
            this.options.search!.provider,
            ...(policy.model || policy.embedding ? ["openai" as const] : []),
          ];
      for (const [period, limit] of [
        ["month", this.monthlyProviderCostMicrousd],
        ["day", policy.dailyCostMicrousd],
      ] as const) {
        if (limit === undefined) continue;
        const used = await reserved(
          "provider_allowances",
          "reserved_microusd",
          period,
        );
        if (Number.isSafeInteger(cost) && used + cost > limit)
          return {
            resource: "search_model_budget",
            reason: "operator_limit",
            allowance: "configured",
            period,
            resets_at: period === "month" ? monthEnd : dayEnd,
            services,
            limit,
            used,
            unit: "microusd",
          };
      }
    }
    return undefined;
  }
  private capacityFailureMessage(capacity: ResearchCapacity): string {
    return `${capacity.period === "month" ? "Monthly" : "Daily"} ${capacity.resource === "flight_compute" ? "Flight execution" : "provider"} reserve is exhausted`;
  }
  private async queuedEnvelope(job: Row): Promise<Row> {
    const result = this.envelope(job);
    if (job.status !== "queued" || job.dispatch_intent_at || job.flight_run_id)
      return result;
    const capacity = await this.transaction(false, (client) =>
      this.capacityForJob(client, job),
    );
    return {
      ...result,
      can_resume: !!this.options.allowSubmission && !capacity,
      ...(capacity
        ? {
            capacity,
            dispatch_blocked: {
              code: "budget_exhausted",
              message: this.capacityFailureMessage(capacity),
              capacity,
            },
          }
        : {}),
    };
  }

  private request(
    params: Row,
    operation: string,
  ): { request: Row; requestId: string; hash: string } {
    let request: Row;
    if (operation === "query" || operation === "explain") {
      const allowed = new Set([
        "query",
        "request_id",
        "parameters",
        "inputs",
        "profile",
        "budgets",
        "partial_policy",
        "source_mode",
        "row_id_column",
        "continuation_of",
        "research_requirements",
        "answer_intent",
      ]);
      if (
        Object.keys(params).some((key) => !allowed.has(key)) ||
        typeof params.query !== "string" ||
        !params.query.trim() ||
        Buffer.byteLength(params.query) > 32768 ||
        ![
          "fixture",
          ...(this.options.exa
            ? Object.keys(exaSearchTypes(this.options.exa))
            : []),
          ...(this.options.search ? [this.options.search.provider] : []),
        ].includes(params.profile ?? "fixture")
      )
        throw new BackendError(
          "invalid_request",
          "Hosted jobs require a bounded configured query",
        );
      const requestId = identity(params.request_id);
      const deadline = this.maxRuntime - 20;
      const budgets = params.budgets ?? {};
      if (
        budgets.dispatch_deadline_seconds !== undefined &&
        budgets.dispatch_deadline_seconds > deadline
      )
        throw new BackendError(
          "invalid_request",
          "Query deadline exceeds the hosted Flight limit",
        );
      request = {
        ...params,
        request_id: requestId,
        profile: params.profile ?? "fixture",
        parameters: params.parameters ?? {},
        inputs: params.inputs ?? {},
        budgets: {
          ...budgets,
          dispatch_deadline_seconds:
            budgets.dispatch_deadline_seconds ?? deadline,
        },
      };
      if (isExaProfile(request.profile)) {
        const research = this.options.exa!.policyVersion === "exa-research.v3";
        if (
          params.source_mode !== undefined &&
          !(
            research ? ["allow_excerpt", "require_document"] : ["allow_excerpt"]
          ).includes(params.source_mode)
        )
          throw new BackendError(
            "unsupported_capability",
            "Source mode is unavailable in the configured hosted Exa policy",
          );
        try {
          request.budgets = exaBudgets(budgets, this.options.exa!, deadline);
        } catch {
          throw new BackendError(
            "invalid_request",
            "Hosted Exa budget exceeds operator approval",
          );
        }
        request.source_mode = params.source_mode ?? "allow_excerpt";
      } else if (isHostedSearchProfile(request.profile)) {
        const research =
          isHostedSearchResearch(this.options.search!) &&
          request.profile !== "deepseek";
        if (
          params.source_mode !== undefined &&
          !(
            research ? ["allow_excerpt", "require_document"] : ["allow_excerpt"]
          ).includes(params.source_mode)
        )
          throw new BackendError(
            "unsupported_capability",
            "Source mode is unavailable in the configured hosted search policy",
          );
        try {
          request.budgets = hostedSearchBudgets(
            budgets,
            this.options.search!,
            deadline,
          );
        } catch (error) {
          throw new BackendError(
            "invalid_request",
            error instanceof Error &&
              error.message ===
                "Hosted search budget cannot cover one estimated request"
              ? "The allowance cannot cover one search or native fetch request; adjust the budget or use saved sources only"
              : "Hosted search budget is outside the configured execution limits",
          );
        }
        request.source_mode = params.source_mode ?? "allow_excerpt";
      }
    } else {
      if (!["import_table", "import", "recover_run"].includes(operation))
        throw new BackendError(
          "unsupported_capability",
          "Hosted operation unavailable",
        );
      request = { ...params };
    }
    const json = stable(request);
    if (Buffer.byteLength(json) > 16 * 1024 * 1024)
      throw new BackendError(
        "budget_exhausted",
        "Job payload exceeds storage allowance",
      );
    const hash = digest(stable({ operation, request }));
    const requestId =
      operation === "query" || operation === "explain"
        ? request.request_id
        : `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    return { request, requestId, hash };
  }
  async enqueue(params: Row, operation = "query"): Promise<Row> {
    const input = this.request(params, operation);
    const jobId = await this.transaction(true, async (client) => {
      const prior = (
        await client.query(
          `SELECT CAST(id AS VARCHAR) AS id,request_hash FROM ${this.table("jobs")} WHERE request_id=$1::UUID`,
          [input.requestId],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== input.hash)
          throw new BackendError(
            "idempotency_conflict",
            "Request key already has different inputs",
          );
        return prior.id;
      }
      const queued = (
        await client.query(
          `SELECT count(*)::INTEGER AS count FROM ${this.table("jobs")} WHERE status='queued'`,
        )
      ).rows[0];
      if (queued.count >= 100)
        throw new BackendError(
          "budget_exhausted",
          "Job queue allowance exhausted",
        );
      const retained = (
        await client.query(
          `SELECT coalesce(sum(octet_length(encode(request_json))),0)::DOUBLE AS bytes FROM ${this.table("jobs")}`,
        )
      ).rows[0];
      if (
        retained.bytes + Buffer.byteLength(stable(input.request)) >
        100 * 1024 * 1024
      )
        throw new BackendError(
          "budget_exhausted",
          "Retained job payload allowance exhausted",
        );
      const id = randomUUID(),
        time = stamp();
      await client.query(
        `INSERT INTO ${this.table("jobs")}(id,request_id,operation,request_hash,request_json,status,created_at,updated_at,flight_id,max_runtime_sec,provider_policy_sha256)
        VALUES($1::UUID,$2::UUID,$3,$4,$5,'queued',$6,$6,$7::UUID,$8::INTEGER,$9)`,
        [
          id,
          input.requestId,
          operation,
          input.hash,
          stable(input.request),
          time,
          this.options.flightId,
          this.maxRuntime,
          (operation === "query" || operation === "explain") &&
          (isExaProfile(input.request.profile) ||
            isHostedSearchProfile(input.request.profile))
            ? livePolicyFingerprint(this.options)
            : null,
        ],
      );
      return id;
    });
    let job = await this.transaction(false, (client) =>
      this.getJob(client, jobId),
    );
    let dispatchBlocked: { code: string; message: string } | undefined;
    if (job.status === "queued" && this.options.allowSubmission) {
      try {
        job = await this.startJob(jobId);
      } catch (error) {
        if (
          !(error instanceof BackendError) ||
          error.code !== "budget_exhausted"
        )
          throw error;
        const retained = await this.transaction(false, (client) =>
          this.getJob(client, jobId),
        );
        // A known allowance refusal before dispatch leaves a recoverable queue
        // handle. Never describe an uncertain or already dispatched job as blocked.
        if (
          retained.status !== "queued" ||
          retained.dispatch_intent_at !== null ||
          retained.flight_run_id !== null ||
          Number(retained.provider_cost_reserved_microusd) !== 0
        )
          throw error;
        job = retained;
        dispatchBlocked = { code: error.code, message: error.message };
      }
    }
    if (
      !["query", "explain"].includes(operation) &&
      job.status === "completed"
    ) {
      const result = await this.readResult({ result_id: job.result_id });
      return {
        ...result,
        ...(job.output_json ? JSON.parse(job.output_json) : {}),
      };
    }
    if (
      !["query", "explain"].includes(operation) &&
      ["failed", "cancelled"].includes(job.status)
    )
      throw new BackendError(
        job.status === "cancelled" ? "cancelled" : "execution_failed",
        "Stored materialization did not complete; inspect its job before creating new work",
      );
    if (job.status === "completed") await this.authorizeCompletedJob(job);
    const envelope = await this.queuedEnvelope(job);
    return {
      ...envelope,
      ...(dispatchBlocked && !envelope.dispatch_blocked
        ? { dispatch_blocked: dispatchBlocked }
        : {}),
    };
  }
  async startJob(id: string): Promise<Row> {
    id = identity(id);
    if (!this.options.allowSubmission)
      throw new BackendError(
        "unsupported_capability",
        "Flight submission is disabled by the operator",
      );
    const candidate = await this.transaction(false, (client) =>
      this.getJob(client, id),
    );
    if (candidate.status !== "queued") {
      if (candidate.status === "completed")
        await this.authorizeCompletedJob(candidate);
      return candidate;
    }
    if (candidate.flight_id !== this.options.flightId)
      throw new BackendError(
        "unsupported_capability",
        "Queued job belongs to a different configured Flight",
      );
    if (
      candidate.provider_policy_sha256 &&
      candidate.provider_policy_sha256 !== livePolicyFingerprint(this.options)
    )
      throw new BackendError(
        "unsupported_capability",
        "Queued provider approval changed; reconcile the existing job",
      );
    const previous = await this.transaction(
      false,
      async (client) =>
        (
          await client.query(
            `SELECT CAST(id AS VARCHAR) AS id FROM ${this.table("jobs")} WHERE dispatch_intent_at IS NOT NULL AND flight_settled=false`,
          )
        ).rows,
    );
    for (const active of previous) await this.jobStatus(active.id);
    const version = await this.connection(async (client) => {
      const summary = (
        await client.query(
          `SELECT current_version,schedule_cron FROM md_get_flight(flight_id := '${this.options.flightId}'::UUID)`,
        )
      ).rows[0];
      if (!summary || summary.schedule_cron)
        throw new BackendError(
          "unsupported_capability",
          "Configured Flight must be on demand",
        );
      const number = bounded(Number(summary.current_version), 1, 4294967295);
      const detail = (
        await client.query(`SELECT instance_type,max_runtime_sec,CAST(config AS JSON)::VARCHAR AS config_json,
        sha256(source_code) AS source_hash,sha256(requirements_txt) AS requirements_hash,CAST(flight_secret_names AS JSON)::VARCHAR AS secrets_json FROM md_get_flight_version(flight_id := '${this.options.flightId}'::UUID,version_number := ${number}::UINTEGER)`)
      ).rows[0];
      const config = detail ? JSON.parse(detail.config_json) : {};
      if (
        !detail ||
        detail.instance_type !== "F4" ||
        Number(detail.max_runtime_sec) !== this.maxRuntime ||
        detail.source_hash !== this.options.sourceSha256 ||
        detail.requirements_hash !== this.options.requirementsSha256 ||
        config.NAMESPACE !== this.namespace ||
        config.STORAGE_SCHEMA !== this.schema ||
        config.DATABASE !== this.options.database ||
        !Object.hasOwn(config, "JOB_ID")
      )
        throw new BackendError(
          "unsupported_capability",
          "Configured Flight differs from the reviewed owner, code or execution limits",
        );
      if (this.options.exa) {
        const policy = this.options.exa;
        const required = exaConfiguration(policy);
        const secrets = JSON.parse(detail.secrets_json ?? "[]");
        const configuredPolicy = {
          ...config,
          SOURCESQL_EXA_POLICY_VERSION:
            config.SOURCESQL_EXA_POLICY_VERSION ?? "exa-search.v1",
        };
        if (
          config.SOURCESQL_ALLOW_LIVE_BRAVE === "1" ||
          config.SOURCESQL_ALLOW_LIVE_SERPER === "1" ||
          config.SOURCESQL_ALLOW_LIVE_DEEPSEEK === "1" ||
          Object.entries(required).some(
            ([key, value]) => configuredPolicy[key] !== value,
          ) ||
          (!policy.model?.reasoningEffort &&
            config.SOURCESQL_OPENAI_REASONING_EFFORT !== undefined) ||
          (!policy.model &&
            (config.SOURCESQL_OPENAI_MODEL !== undefined ||
              config.SOURCESQL_OPENAI_SECRET_NAME !== undefined ||
              config.SOURCESQL_OPENAI_REASONING_EFFORT !== undefined)) ||
          (!policy.embedding &&
            (config.SOURCESQL_OPENAI_EMBEDDING_MODEL !== undefined ||
              config.SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME !== undefined)) ||
          !Array.isArray(secrets) ||
          !secrets.includes(policy.secretName) ||
          (policy.model && !secrets.includes(policy.model.secretName)) ||
          (policy.embedding && !secrets.includes(policy.embedding.secretName))
        )
          throw new BackendError(
            "unsupported_capability",
            "Flight Exa approval or secret binding differs from the operator policy",
          );
      }
      if (this.options.search) {
        const policy = this.options.search;
        const required = hostedSearchConfiguration(policy);
        const secrets = JSON.parse(detail.secrets_json ?? "[]");
        const enabled = ["EXA", "BRAVE", "SERPER", "DEEPSEEK"].filter(
          (provider) => config[`SOURCESQL_ALLOW_LIVE_${provider}`] === "1",
        );
        if (
          enabled.length !== 1 ||
          enabled[0] !== policy.provider.toUpperCase() ||
          Object.entries(required).some(
            ([key, value]) => config[key] !== value,
          ) ||
          (isHostedSearchResearch(policy) &&
            !policy.model?.reasoningEffort &&
            config.SOURCESQL_OPENAI_REASONING_EFFORT !== undefined) ||
          (isHostedSearchResearch(policy) &&
            !policy.model &&
            (config.SOURCESQL_OPENAI_MODEL !== undefined ||
              config.SOURCESQL_OPENAI_SECRET_NAME !== undefined ||
              config.SOURCESQL_OPENAI_REASONING_EFFORT !== undefined)) ||
          (isHostedSearchResearch(policy) &&
            !policy.embedding &&
            (config.SOURCESQL_OPENAI_EMBEDDING_MODEL !== undefined ||
              config.SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME !== undefined)) ||
          !Array.isArray(secrets) ||
          !secrets.includes(policy.secretName) ||
          (policy.model && !secrets.includes(policy.model.secretName)) ||
          (policy.embedding && !secrets.includes(policy.embedding.secretName))
        )
          throw new BackendError(
            "unsupported_capability",
            "Flight search approval or secret binding differs from the operator policy",
          );
      }
      return number;
    });
    const claimed = await this.transaction(true, async (client) => {
      const job = await this.getJob(client, id);
      if (job.status !== "queued") return { job, dispatch: false };
      const active = (
        await client.query(
          `SELECT count(*)::INTEGER AS count FROM ${this.table("jobs")} WHERE status IN ('dispatching','running','submission_unknown') OR (dispatch_intent_at IS NOT NULL AND flight_settled=false)`,
        )
      ).rows[0];
      if (active.count) return { job, dispatch: false };
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (this.usageMode === "operator_reserved")
        await client.query(
          `INSERT OR IGNORE INTO ${this.table("flight_allowances")} VALUES($1,0)`,
          [day],
        );
      const capacity = await this.capacityForJob(client, job, now);
      if (capacity)
        throw new BackendError(
          "budget_exhausted",
          this.capacityFailureMessage(capacity),
        );
      if (job.operation === "query" && job.provider_policy_sha256) {
        const policy = this.options.exa ?? this.options.search;
        const cost = Number(
          JSON.parse(job.request_json).budgets.max_cost_microusd,
        );
        if (
          !policy ||
          job.provider_policy_sha256 !== livePolicyFingerprint(this.options) ||
          !Number.isSafeInteger(cost) ||
          cost < 1 ||
          cost > policy.approvedCostMicrousd
        )
          throw new BackendError(
            "invalid_request",
            "Stored provider approval is unavailable",
          );
        if (this.usageMode === "operator_reserved") {
          await client.query(
            `INSERT OR IGNORE INTO ${this.table("provider_allowances")} VALUES($1,0)`,
            [day],
          );

          await client.query(
            `UPDATE ${this.table("provider_allowances")} SET reserved_microusd=reserved_microusd+$1::BIGINT WHERE day=$2`,
            [cost, day],
          );
          await client.query(
            `UPDATE ${this.table("jobs")} SET provider_cost_reserved_microusd=$1::BIGINT WHERE id=$2::UUID`,
            [cost, id],
          );
        }
      }
      if (this.usageMode === "operator_reserved")
        await client.query(
          `UPDATE ${this.table("flight_allowances")} SET reserved_seconds=reserved_seconds+$1::BIGINT WHERE day=$2`,
          [this.maxRuntime, day],
        );
      await client.query(
        `UPDATE ${this.table("jobs")} SET status='dispatching',flight_version=$3::INTEGER,dispatch_intent_at=$1,updated_at=$1 WHERE id=$2::UUID`,
        [stamp(), id, version],
      );
      return { job: await this.getJob(client, id), dispatch: true };
    });
    if (!claimed.dispatch) return claimed.job;
    let run: Row;
    try {
      const rows = await this.connection(
        async (client) =>
          (
            await client.query(`SELECT ${runColumns} FROM md_run_flight(
        flight_id := '${this.options.flightId}'::UUID, config := MAP {'JOB_ID': '${id}'})`)
          ).rows,
      );
      if (rows.length !== 1)
        throw new BackendError(
          "submission_unknown",
          "Flight submission outcome is uncertain",
        );
      run = rows[0];
      const config = JSON.parse(run.config_json);
      if (
        run.flight_id !== this.options.flightId ||
        Number(run.flight_version) !== version ||
        config.JOB_ID !== id ||
        config.NAMESPACE !== this.namespace ||
        config.STORAGE_SCHEMA !== this.schema ||
        config.DATABASE !== this.options.database ||
        !uuidPattern.test(run.run_id) ||
        !/^[1-9][0-9]{0,19}$/.test(run.run_number)
      ) {
        if (
          run.flight_id === this.options.flightId &&
          uuidPattern.test(run.run_id) &&
          /^[1-9][0-9]{0,19}$/.test(run.run_number)
        ) {
          await this.transaction(true, async (client) => {
            await client.query(
              `UPDATE ${this.table("jobs")} SET flight_run_id=$1::UUID,flight_run_number=$2::UBIGINT,
              flight_invalid=true,status='failed',error_code='flight_definition_changed',updated_at=$3 WHERE id=$4::UUID
              AND status NOT IN ('completed','cancelled')`,
              [run.run_id, run.run_number, stamp(), id],
            );
          });
          await this.connection((client) =>
            client.query(`SELECT * FROM md_cancel_flight_run(
            flight_id := '${this.options.flightId}'::UUID,run_number := ${run.run_number}::UBIGINT)`),
          ).catch(() => undefined);
        }
        throw new BackendError(
          "submission_unknown",
          "Flight submission outcome is uncertain",
        );
      }
    } catch {
      await this.transaction(true, async (client) => {
        await client.query(
          `UPDATE ${this.table("jobs")} SET status='submission_unknown',updated_at=$1 WHERE id=$2::UUID AND status='dispatching' AND claim_token IS NULL`,
          [stamp(), id],
        );
      }).catch(() => undefined);
      return this.transaction(false, (client) => this.getJob(client, id));
    }
    return this.transaction(true, async (client) => {
      await client.query(
        `UPDATE ${this.table("jobs")} SET flight_run_id=$1::UUID,flight_run_number=$2::UBIGINT,updated_at=$3 WHERE id=$4::UUID`,
        [run.run_id, run.run_number, stamp(), id],
      );
      return this.getJob(client, id);
    });
  }
  async jobStatus(id: string): Promise<Row> {
    id = identity(id);
    let job = await this.transaction(false, (client) =>
      this.getJob(client, id),
    );
    if (
      ["dispatching", "submission_unknown", "running"].includes(job.status) ||
      (terminal.has(job.status) &&
        job.dispatch_intent_at &&
        !job.flight_settled)
    ) {
      const runs = await this.connection(async (client) => {
        const sql = job.flight_run_number
          ? `md_get_flight_run(flight_id := '${job.flight_id}'::UUID,run_number := ${job.flight_run_number}::UBIGINT)`
          : `md_list_flight_runs(flight_id := '${job.flight_id}'::UUID,"LIMIT" := 100)`;
        return (
          await client.query(`SELECT ${runColumns} FROM ${sql}`)
        ).rows.filter(
          (run) =>
            (job.flight_invalid && run.run_id === job.flight_run_id) ||
            JSON.parse(run.config_json).JOB_ID === id,
        );
      });
      if (runs.length === 1) {
        const run = runs[0],
          config = JSON.parse(run.config_json);
        if (
          job.flight_invalid
            ? run.run_id !== job.flight_run_id ||
              run.flight_id !== job.flight_id
            : config.NAMESPACE !== this.namespace ||
              config.STORAGE_SCHEMA !== this.schema ||
              config.DATABASE !== this.options.database ||
              run.flight_id !== job.flight_id ||
              Number(run.flight_version) !== Number(job.flight_version)
        )
          throw new BackendError(
            "unauthorized",
            "Flight/job identity mismatch",
          );
        const status = String(run.status).replace(/^RUN_STATUS_/, "");
        // Ordinary polling must not contend with the Flight's publication writer.
        if (
          job.flight_run_id === run.run_id &&
          job.flight_run_number === run.run_number &&
          !["SUCCEEDED", "FAILED", "CANCELLED"].includes(status)
        ) {
          if (job.status === "completed") await this.authorizeCompletedJob(job);
          return this.envelope(job);
        }
        job = await this.transaction(true, async (client) => {
          const current = await this.getJob(client, id);
          if (!terminal.has(current.status) || !current.flight_settled) {
            await client.query(
              `UPDATE ${this.table("jobs")} SET flight_run_id=$1::UUID,flight_run_number=$2::UBIGINT,updated_at=$3 WHERE id=$4::UUID`,
              [run.run_id, run.run_number, stamp(), id],
            );
            if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(status)) {
              await this.recordFlightUsage(client, current, run);
              await client.query(
                `UPDATE ${this.table("jobs")} SET flight_settled=true,updated_at=$1 WHERE id=$2::UUID`,
                [stamp(), id],
              );
              if (!terminal.has(current.status))
                await client.query(
                  `UPDATE ${this.table("jobs")} SET status='failed',error_code='execution_outcome_unknown',error_message='No durable result was published',updated_at=$1 WHERE id=$2::UUID`,
                  [stamp(), id],
                );
            }
          }
          return this.getJob(client, id);
        });
      }
      // No match or multiple matches stays uncertain. Never repeat submission.
    }
    if (job.status === "completed") await this.authorizeCompletedJob(job);
    const result = await this.queuedEnvelope(job);
    const capacity = await this.providerCapacity(job);
    return { ...result, ...(capacity ? { capacity } : {}) };
  }
  async cancelJob(id: string): Promise<Row> {
    id = identity(id);
    const job = await this.transaction(true, async (client) => {
      const current = await this.getJob(client, id);
      if (terminal.has(current.status)) return current;
      await client.query(
        `UPDATE ${this.table("jobs")} SET status='cancelled',cancel_requested=true,updated_at=$1 WHERE id=$2::UUID`,
        [stamp(), id],
      );
      if (current.engine_run_id) {
        const row = (
          await client.query(
            `SELECT receipt FROM ${this.table("runs")} WHERE id=$1`,
            [current.engine_run_id],
          )
        ).rows[0];
        if (row) {
          const receipt = JSON.parse(row.receipt);
          if (
            !["completed", "partial", "failed", "cancelled"].includes(
              receipt.status,
            )
          ) {
            await client.query(
              `UPDATE ${this.table("runs")} SET receipt=$1 WHERE id=$2`,
              [
                stable({
                  ...receipt,
                  status: "cancelled",
                  finished_at: stamp(),
                  result_id: null,
                  plan_complete: false,
                  receipt_revision: receipt.receipt_revision + 1,
                }),
                current.engine_run_id,
              ],
            );
          }
        }
      }
      return this.getJob(client, id);
    });
    if (job.flight_run_number && job.cancel_requested) {
      // Durable cancellation wins even if platform cancellation cannot be acknowledged.
      await this.connection((client) =>
        client.query(`SELECT * FROM md_cancel_flight_run(
        flight_id := '${job.flight_id}'::UUID,run_number := ${job.flight_run_number}::UBIGINT)`),
      ).catch(() => undefined);
    }
    if (job.status === "completed") await this.authorizeCompletedJob(job);
    return this.envelope(job);
  }
  private async exportResult(id: string): Promise<Row> {
    return this.transaction(false, async (client) => {
      const records: Row = {};
      const include = async (rid: string) => {
        if (records[rid]) return;
        const row = await this.resultRecord(client, rid);
        for (const parent of row.parsed.parents ?? [])
          await include(parent.result_id);
        records[rid] = {
          metadata_json: row.metadata,
          payload_json: row.payload,
        };
      };
      await include(identity(id, resultPattern));
      const raw = stable({
        format: "sourcesql.remote-records.v1",
        root_result_id: id,
        records,
      });
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024)
        throw new BackendError("budget_exhausted", "Export exceeds allowance");
      return {
        format: "sourcesql.remote-archive.v1",
        encoding: "base64",
        sha256: digest(raw),
        data: Buffer.from(raw).toString("base64"),
      };
    });
  }
  async call<T = Row>(method: string, params: Row = {}): Promise<T> {
    let result: unknown;
    if (method === "capabilities")
      result = {
        engine_version: this.options.engineVersion ?? null,
        engine_version_source: this.options.engineVersion
          ? "configured_flight_pin"
          : "unknown",
        dialect: "duckdb",
        sqlglot_version: "30.19.0",
        operators: [
          "WEB_SEARCH",
          "SOURCE_WINDOW",
          "WEB_FETCH",
          "SEM_MATCH",
          "SEM_EXTRACT",
          "SEM_EXTRACT_ALL",
          "SEM_SCORE",
          "SEM_NORM",
        ],
        input_views:
          this.options.engineVersion === "0.2.3"
            ? ["original", "effective", "sources"]
            : ["original", "effective"],
        semantic_limits: { extract_all_max_items_per_call: 8 },
        default_profile: "fixture",
        recommended_research_profile: this.options.exa
          ? "exa"
          : (this.options.search?.provider ?? null),
        profiles: [
          {
            name: "fixture",
            mode: "fixture",
            provider: "fixture",
            live_qualified: false,
          },
          ...(this.options.exa
            ? Object.entries(exaSearchTypes(this.options.exa)).map(
                ([name, search_type]) => ({
                  name,
                  mode: "live",
                  provider: "exa",
                  live_qualified: false,
                  operators: exaOperators(this.options.exa!),
                  search_type,
                  source_mode: "allow_excerpt",
                  model_configured: !!this.options.exa!.model,
                  model_name: this.options.exa!.model?.name ?? null,
                  embedding_configured: !!this.options.exa!.embedding,
                  embedding_model: this.options.exa!.embedding?.name ?? null,
                  embedding_adapter_version: this.options.exa!.embedding
                    ? "openai-embeddings.v2"
                    : null,
                  score_basis: this.options.exa!.embedding
                    ? "cosine_similarity"
                    : null,
                  embedding_input_max_tokens: this.options.exa!.embedding
                    ? 8192
                    : null,
                  embedding_batch_max_tokens: this.options.exa!.embedding
                    ? 300_000
                    : null,
                  embedding_token_encoding: this.options.exa!.embedding
                    ? "cl100k_base"
                    : null,
                  embedding_batch_max_inputs: this.options.exa!.embedding
                    ? 128
                    : null,
                  fetched_text_coverage:
                    this.options.exa!.policyVersion === "exa-research.v3"
                      ? "Retained provider text; completeness is not established"
                      : null,
                  search_limits: {
                    ...exaResearchLimits(this.options.exa!),
                    max_cost_microusd: this.options.exa!.approvedCostMicrousd,
                    dispatch_deadline_seconds: exaDeadline(
                      this.options.exa!,
                      this.maxRuntime - 20,
                    ),
                  },
                  broad_discovery:
                    "Separate diverse WEB_SEARCH queries preserve per-query source attribution",
                  research_agent_configured: false,
                }),
              )
            : []),
          ...(this.options.search
            ? [
                {
                  name: this.options.search.provider,
                  mode: "live",
                  provider: this.options.search.provider,
                  live_qualified: false,
                  operators: hostedSearchOperators(this.options.search),
                  source_mode: "allow_excerpt",
                  model_configured: !!this.options.search.model,
                  model_name: this.options.search.model?.name ?? null,
                  embedding_configured: !!this.options.search.embedding,
                  embedding_model: this.options.search.embedding?.name ?? null,
                  embedding_adapter_version: this.options.search.embedding
                    ? "openai-embeddings.v2"
                    : null,
                  score_basis: this.options.search.embedding
                    ? "cosine_similarity"
                    : null,
                  embedding_input_max_tokens: this.options.search.embedding
                    ? 8192
                    : null,
                  embedding_batch_max_tokens: this.options.search.embedding
                    ? 300_000
                    : null,
                  embedding_token_encoding: this.options.search.embedding
                    ? "cl100k_base"
                    : null,
                  embedding_batch_max_inputs: this.options.search.embedding
                    ? 128
                    : null,
                  fetched_text_coverage: isHostedSearchResearch(
                    this.options.search,
                  )
                    ? this.options.search.provider === "deepseek"
                      ? "Retained provider Markdown/text; completeness and forced freshness are not established"
                      : "Public HTML/text fetched directly; rendered JavaScript and PDF extraction are unavailable"
                    : null,
                  search_limits: hostedSearchBudgets(
                    {},
                    this.options.search,
                    this.maxRuntime - 20,
                  ),
                  cost_reporting:
                    this.options.search.provider === "deepseek"
                      ? "published_rate_estimate_not_billing"
                      : "unavailable",
                  ...(this.options.search.provider === "deepseek"
                    ? {
                        source_modes: ["allow_excerpt"],
                        search_query_max_characters: 128,
                        search_per_query_max_results: 50,
                        fetch_modes: isHostedSearchResearch(this.options.search)
                          ? ["cache_preferred"]
                          : [],
                        provider_ranking_is_sem_score: false,
                      }
                    : {}),
                  estimated_request_cost_microusd:
                    this.options.search.requestCostMicrousd,
                  broad_discovery:
                    "Separate diverse WEB_SEARCH queries preserve per-query source attribution",
                  research_agent_configured: false,
                },
              ]
            : []),
        ],
        execution_mode: "async_jobs",
        storage: "motherduck",
        max_flight_runtime_seconds: this.maxRuntime,
        usage_mode: this.usageMode,
        usage_reporting: true,
        daily_execution_reserve_seconds:
          this.usageMode === "operator_reserved"
            ? (this.dailySeconds ?? null)
            : null,
        monthly_execution_reserve_seconds:
          this.usageMode === "operator_reserved"
            ? (this.monthlySeconds ?? null)
            : null,
        monthly_provider_reserve_microusd:
          this.usageMode === "operator_reserved"
            ? (this.monthlyProviderCostMicrousd ?? null)
            : null,
        reservation_period: "UTC calendar month; optional UTC day",
        flight_submission_enabled: !!this.options.allowSubmission,
        limitations: [
          this.options.exa?.policyVersion === "exa-research.v3" ||
          (this.options.search && isHostedSearchResearch(this.options.search))
            ? "Live research uses retained source text; exact quotes establish text support, not source completeness or factual truth"
            : "Hosted private profiles are not configured; optional live providers are search-only",
          "Hosted explain runs canonical admission in a provider-free Flight and consumes configured Flight capacity",
          "Queued jobs require explicit start; status never dispatches",
          this.usageMode === "provider_managed"
            ? "Provider-managed usage: reference allowance notices do not block work; finite per-job bounds remain enforced"
            : "Execution reserves are not an account-wide billing cap",
          "Usage reports cover sourcesQL activity, not provider account-wide balances or final bills",
        ],
      };
    else if (method === "query" || method === "explain")
      result = await this.enqueue(params, method);
    else if (method === "resume_run") {
      if (
        Object.keys(params).some(
          (key) => !["run_id", "request_id"].includes(key),
        )
      )
        throw new BackendError(
          "invalid_request",
          "Invalid continuation request",
        );
      const previous = await this.call<Row>("run_status", {
        run_id: params.run_id,
      });
      if (
        previous.status !== "failed" ||
        previous.settlement_status !== "settled" ||
        !previous.resume_request
      )
        throw new BackendError(
          "unsupported_capability",
          "Run cannot continue without inspection",
        );
      result = await this.enqueue({
        ...previous.resume_request,
        request_id: identity(params.request_id),
        continuation_of: params.run_id,
      });
    } else if (
      method === "import_table" ||
      method === "import" ||
      method === "recover_run"
    )
      result = await this.enqueue(params, method);
    else if (method === "usage_report") result = await this.usageReport(params);
    else if (method === "usage_notices") result = await this.usageNotices();
    else if (method === "dismiss_usage_notice") {
      const noticeId = identity(params.notice_id, /^[a-f0-9]{64}$/);
      if (Object.keys(params).some((key) => key !== "notice_id"))
        throw new BackendError("invalid_request", "Invalid usage notice");
      await this.transaction(true, async (client) => {
        await client.query(
          `INSERT OR IGNORE INTO ${this.table("usage_notice_dismissals")} VALUES($1,$2)`,
          [noticeId, stamp()],
        );
      });
      result = { dismissed: true };
    } else if (method === "read_result") result = await this.readResult(params);
    else if (method === "job_status")
      result = await this.jobStatus(params.job_id);
    else if (method === "cancel_job")
      result = await this.cancelJob(params.job_id);
    else if (method === "start_job")
      result = this.envelope(await this.startJob(params.job_id));
    else if (method === "export")
      result = await this.exportResult(params.result_id);
    else if (method === "run_status") {
      result = await this.transaction(false, async (client) => {
        const row = (
          await client.query(
            `SELECT receipt FROM ${this.table("runs")} WHERE id=$1`,
            [identity(params.run_id, resultPattern)],
          )
        ).rows[0];
        if (!row) throw new BackendError("not_found", "Run unavailable");
        const receipt = JSON.parse(row.receipt);
        if (
          ["private_local", "private_derived"].includes(
            receipt.data_classification,
          )
        )
          throw new BackendError("unauthorized", "Private run unavailable");
        for (const parent of receipt.parents ?? [])
          await this.resultRecord(client, parent.result_id);
        if (receipt.result_id)
          await this.resultRecord(client, receipt.result_id);
        return receipt;
      });
    } else
      throw new BackendError(
        "unsupported_capability",
        "Operation is unavailable in the native hosted backend",
      );
    return result as T;
  }
}

export class MotherDuckStateBackend implements ResearchStateBackend {
  constructor(private engine: MotherDuckEngine) {}
  async read(): Promise<{ state?: ResearchState; version: string }> {
    return this.engine.transaction(false, async (client) => {
      const row = (
        await client.query(
          `SELECT CAST(revision AS VARCHAR) AS revision,state_json FROM ${this.engine.table("app_state")} WHERE id=1`,
        )
      ).rows[0];
      return row
        ? { state: JSON.parse(row.state_json), version: row.revision }
        : { version: "0" };
    });
  }
  async write(state: ResearchState, expectedVersion: string): Promise<void> {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(expectedVersion))
      throw new BackendError("invalid_request", "Invalid storage revision");
    const json = stable(state);
    if (Buffer.byteLength(json) > 16 * 1024 * 1024)
      throw new BackendError(
        "budget_exhausted",
        "Research state exceeds allowance",
      );
    await this.engine.transaction(true, async (client) => {
      const row = (
        await client.query(
          `SELECT CAST(revision AS VARCHAR) AS revision FROM ${this.engine.table("app_state")} WHERE id=1`,
        )
      ).rows[0];
      if ((row?.revision ?? "0") !== expectedVersion)
        throw new BackendError(
          "revision_conflict",
          "Research changed; reload before editing",
        );
      const retained = (
        await client.query(
          `SELECT coalesce(sum(octet_length(encode(state_json))),0)::DOUBLE AS bytes FROM ${this.engine.table("app_state_history")}`,
        )
      ).rows[0];
      if (retained.bytes + Buffer.byteLength(json) > 100 * 1024 * 1024)
        throw new BackendError(
          "budget_exhausted",
          "Research history storage allowance exhausted",
        );
      const revision = (BigInt(expectedVersion) + 1n).toString();
      if (row)
        await client.query(
          `UPDATE ${this.engine.table("app_state")} SET revision=$1::BIGINT,state_json=$2 WHERE id=1`,
          [revision, json],
        );
      else
        await client.query(
          `INSERT INTO ${this.engine.table("app_state")} VALUES(1,$1::BIGINT,$2)`,
          [revision, json],
        );
      await client.query(
        `INSERT INTO ${this.engine.table("app_state_history")} VALUES($1::BIGINT,$2,$3)`,
        [revision, json, stamp()],
      );
    });
  }
}

export async function createMotherDuckBackend(
  environment: NodeJS.ProcessEnv,
  principal: string,
): Promise<{
  engine: MotherDuckEngine;
  stateBackend: MotherDuckStateBackend;
}> {
  if (
    environment.SOURCESQL_ALLOW_PRIVATE === "1" ||
    environment.SOURCESQL_PROFILES_FILE
  )
    throw new BackendError(
      "unsupported_capability",
      "Hosted private/live profiles require separate configuration",
    );
  const enabledProviders = ["EXA", "BRAVE", "SERPER", "DEEPSEEK"].filter(
    (provider) => environment[`SOURCESQL_ALLOW_LIVE_${provider}`] === "1",
  );
  if (enabledProviders.length > 1)
    throw new BackendError(
      "invalid_request",
      "Choose one live search provider per Flight",
    );
  const selected = enabledProviders[0]?.toLowerCase();
  const researchAdapters: HostedResearchOptions = {
    ...(environment.SOURCESQL_OPENAI_EMBEDDING_MODEL !== undefined ||
    environment.SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME !== undefined
      ? {
          embedding: {
            name: environment.SOURCESQL_OPENAI_EMBEDDING_MODEL ?? "",
            secretName:
              environment.SOURCESQL_OPENAI_EMBEDDING_SECRET_NAME ?? "",
          },
        }
      : {}),
    ...(environment.SOURCESQL_OPENAI_MODEL !== undefined ||
    environment.SOURCESQL_OPENAI_SECRET_NAME !== undefined ||
    environment.SOURCESQL_OPENAI_REASONING_EFFORT !== undefined
      ? {
          model: {
            name: environment.SOURCESQL_OPENAI_MODEL ?? "",
            secretName: environment.SOURCESQL_OPENAI_SECRET_NAME ?? "",
            ...(environment.SOURCESQL_OPENAI_REASONING_EFFORT !== undefined
              ? {
                  reasoningEffort:
                    environment.SOURCESQL_OPENAI_REASONING_EFFORT,
                }
              : {}),
          },
        }
      : {}),
  };
  let search: HostedSearchPolicy | undefined;
  if (isHostedSearchProfile(selected)) {
    const prefix = `SOURCESQL_${selected.toUpperCase()}`;
    search = {
      provider: selected,
      policyVersion: environment[`${prefix}_POLICY_VERSION`],
      secretName: environment[`${prefix}_SECRET_NAME`] ?? "",
      approvedCostMicrousd: Number(
        environment[`${prefix}_APPROVED_COST_MICROUSD`],
      ),
      dailyCostMicrousd: Number(
        environment[`${prefix}_DAILY_COST_MICROUSD`] ??
          environment[`${prefix}_APPROVED_COST_MICROUSD`],
      ),
      requestCostMicrousd: Number(
        environment[`${prefix}_REQUEST_COST_MICROUSD`],
      ),
      ...(environment[`${prefix}_POLICY_VERSION`] ===
      HOSTED_SEARCH_RESEARCH_POLICY_VERSIONS[selected]
        ? researchAdapters
        : {}),
    };
    try {
      validateHostedSearchPolicy(search);
    } catch {
      throw new BackendError(
        "invalid_request",
        "Invalid hosted search configuration",
      );
    }
  }
  const engine = new MotherDuckEngine({
    database: environment.MOTHERDUCK_DB ?? "",
    host: environment.MOTHERDUCK_HOST ?? "",
    token: environment.MOTHERDUCK_TOKEN ?? "",
    flightId: environment.SOURCESQL_FLIGHT_ID ?? "",
    principal,
    usageMode:
      environment.SOURCESQL_USAGE_MODE as MotherDuckOptions["usageMode"],
    allowSubmission: environment.SOURCESQL_ALLOW_FLIGHT_SUBMISSION === "1",
    maxRuntimeSeconds: Number(
      environment.SOURCESQL_FLIGHT_MAX_RUNTIME_SEC ?? 120,
    ),
    dailySeconds:
      environment.SOURCESQL_FLIGHT_DAILY_SECONDS === undefined
        ? undefined
        : Number(environment.SOURCESQL_FLIGHT_DAILY_SECONDS),
    monthlySeconds:
      environment.SOURCESQL_FLIGHT_MONTHLY_SECONDS === undefined
        ? undefined
        : Number(environment.SOURCESQL_FLIGHT_MONTHLY_SECONDS),
    monthlyProviderCostMicrousd:
      environment.SOURCESQL_PROVIDER_MONTHLY_COST_MICROUSD === undefined
        ? undefined
        : Number(environment.SOURCESQL_PROVIDER_MONTHLY_COST_MICROUSD),
    sourceSha256: environment.SOURCESQL_FLIGHT_SOURCE_SHA256,
    engineVersion: environment.SOURCESQL_FLIGHT_ENGINE_VERSION,
    requirementsSha256: environment.SOURCESQL_FLIGHT_REQUIREMENTS_SHA256,
    search,
    exa:
      environment.SOURCESQL_ALLOW_LIVE_EXA === "1"
        ? {
            approvedCostMicrousd: Number(
              environment.SOURCESQL_EXA_APPROVED_COST_MICROUSD ?? 50000,
            ),
            dailyCostMicrousd: Number(
              environment.SOURCESQL_EXA_DAILY_COST_MICROUSD ??
                (environment.SOURCESQL_USAGE_MODE === "provider_managed"
                  ? (environment.SOURCESQL_EXA_APPROVED_COST_MICROUSD ?? 50000)
                  : 1000000),
            ),
            secretName: environment.SOURCESQL_EXA_SECRET_NAME ?? "",
            policyVersion:
              environment.SOURCESQL_EXA_POLICY_VERSION ?? "exa-search.v1",
            ...researchAdapters,
          }
        : undefined,
  });
  await engine.initialize();
  return { engine, stateBackend: new MotherDuckStateBackend(engine) };
}
