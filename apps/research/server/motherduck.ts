/** Native Postgres gateway: durable owner storage, on-demand Flight jobs, no Python bridge. */
import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import type { ResearchEngine, EngineResult } from "./engine.js";
import type { ResearchState, ResearchStateBackend } from "./store.js";
import {
  exaSearchTypes,
  exaDeadline,
  isExaProfile,
  exaBudgets,
  exaFingerprint,
  validateExaPolicy,
  type HostedExaPolicy,
} from "./hosted-exa.js";
import { tableDefinitions, tableMigrations } from "./motherduck-schema.js";
import {
  isHostedSearchProfile,
  validateHostedSearchPolicy,
  hostedSearchFingerprint,
  hostedSearchBudgets,
  hostedSearchConfiguration,
  HOSTED_SEARCH_POLICY_VERSIONS,
  type HostedSearchPolicy,
} from "./hosted-search.js";

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
  maxRuntimeSeconds?: number;
  dailySeconds?: number;
  sourceSha256?: string;
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
  flight_version,CAST(run_number AS VARCHAR) AS run_number,status,exit_code,CAST(config AS JSON)::VARCHAR AS config_json`;

export class MotherDuckEngine implements ResearchEngine {
  readonly namespace: string;
  readonly schema: string;
  readonly maxRuntime: number;
  readonly dailySeconds: number;
  private readonly connectClient?: () => SqlClient;
  private readonly pool?: SqlPool;
  constructor(readonly options: MotherDuckOptions) {
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
    this.dailySeconds = bounded(options.dailySeconds ?? 600, 0, 1800);
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
    return {
      job_id: job.id,
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
      ...(job.status === "completed"
        ? { result_id: job.result_id, run_id: job.engine_run_id }
        : {}),
      ...(job.status === "failed"
        ? {
            error: {
              code: job.error_code ?? "execution_failed",
              message: "Research execution failed safely",
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
    if (operation === "query") {
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
        if (
          params.source_mode !== undefined &&
          params.source_mode !== "allow_excerpt"
        )
          throw new BackendError(
            "unsupported_capability",
            "Hosted Exa initially supports search excerpts only",
          );
        try {
          request.budgets = exaBudgets(budgets, this.options.exa!, deadline);
        } catch {
          throw new BackendError(
            "invalid_request",
            "Hosted Exa budget exceeds operator approval",
          );
        }
        request.source_mode = "allow_excerpt";
      } else if (isHostedSearchProfile(request.profile)) {
        if (
          params.source_mode !== undefined &&
          params.source_mode !== "allow_excerpt"
        )
          throw new BackendError(
            "unsupported_capability",
            "Hosted search supports retained excerpts only",
          );
        try {
          request.budgets = hostedSearchBudgets(
            budgets,
            this.options.search!,
            deadline,
          );
        } catch {
          throw new BackendError(
            "invalid_request",
            "Hosted search budget exceeds operator approval",
          );
        }
        request.source_mode = "allow_excerpt";
      }
    } else {
      if (!["import_table", "import"].includes(operation))
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
      operation === "query"
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
          operation === "query" &&
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
    if (job.status === "queued" && this.options.allowSubmission)
      job = await this.startJob(jobId);
    if (operation !== "query" && job.status === "completed") {
      const result = await this.readResult({ result_id: job.result_id });
      return {
        ...result,
        ...(job.output_json ? JSON.parse(job.output_json) : {}),
      };
    }
    if (operation !== "query" && ["failed", "cancelled"].includes(job.status))
      throw new BackendError(
        job.status === "cancelled" ? "cancelled" : "execution_failed",
        "Stored materialization did not complete; inspect its job before creating new work",
      );
    if (job.status === "completed")
      await this.readResult({ result_id: job.result_id, limit: 0 });
    return this.envelope(job);
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
    if (candidate.status !== "queued") return candidate;
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
        const secrets = JSON.parse(detail.secrets_json ?? "[]");
        if (
          config.SOURCESQL_ALLOW_LIVE_EXA !== "1" ||
          config.SOURCESQL_ALLOW_LIVE_BRAVE === "1" ||
          config.SOURCESQL_ALLOW_LIVE_SERPER === "1" ||
          config.SOURCESQL_EXA_APPROVED_COST_MICROUSD !==
            String(policy.approvedCostMicrousd) ||
          config.SOURCESQL_EXA_SECRET_NAME !== policy.secretName ||
          (config.SOURCESQL_EXA_POLICY_VERSION ?? "exa-search.v1") !==
            (policy.policyVersion ?? "exa-search.v1") ||
          !Array.isArray(secrets) ||
          !secrets.includes(policy.secretName)
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
        const enabled = ["EXA", "BRAVE", "SERPER"].filter(
          (provider) => config[`SOURCESQL_ALLOW_LIVE_${provider}`] === "1",
        );
        if (
          enabled.length !== 1 ||
          enabled[0] !== policy.provider.toUpperCase() ||
          Object.entries(required).some(
            ([key, value]) => config[key] !== value,
          ) ||
          !Array.isArray(secrets) ||
          !secrets.includes(policy.secretName)
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
      const day = new Date().toISOString().slice(0, 10);
      await client.query(
        `INSERT OR IGNORE INTO ${this.table("flight_allowances")} VALUES($1,0)`,
        [day],
      );
      const allowance = (
        await client.query(
          `SELECT CAST(reserved_seconds AS VARCHAR) AS seconds FROM ${this.table("flight_allowances")} WHERE day=$1`,
          [day],
        )
      ).rows[0];
      if (Number(allowance.seconds) + this.maxRuntime > this.dailySeconds)
        throw new BackendError(
          "budget_exhausted",
          "Daily Flight execution reserve is exhausted",
        );
      if (job.provider_policy_sha256) {
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
        await client.query(
          `INSERT OR IGNORE INTO ${this.table("provider_allowances")} VALUES($1,0)`,
          [day],
        );
        const used = (
          await client.query(
            `SELECT CAST(reserved_microusd AS VARCHAR) AS used FROM ${this.table("provider_allowances")} WHERE day=$1`,
            [day],
          )
        ).rows[0];
        if (Number(used.used) + cost > policy.dailyCostMicrousd)
          throw new BackendError(
            "budget_exhausted",
            "Daily provider reserve is exhausted",
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
          if (job.status === "completed")
            await this.readResult({ result_id: job.result_id, limit: 0 });
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
    if (job.status === "completed")
      await this.readResult({ result_id: job.result_id, limit: 0 });
    return this.envelope(job);
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
        engine_version: "0.1.0",
        dialect: "duckdb",
        sqlglot_version: "30.19.0",
        operators: [
          "WEB_SEARCH",
          "WEB_FETCH",
          "SEM_MATCH",
          "SEM_EXTRACT",
          "SEM_EXTRACT_ALL",
          "SEM_SCORE",
          "SEM_NORM",
        ],
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
                  operators: ["WEB_SEARCH"],
                  search_type,
                  source_mode: "allow_excerpt",
                  model_configured: false,
                  embedding_configured: false,
                  search_limits: {
                    max_search_queries: 2,
                    max_search_requests: 2,
                    max_candidates: 10,
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
                  operators: ["WEB_SEARCH"],
                  source_mode: "allow_excerpt",
                  model_configured: false,
                  embedding_configured: false,
                  search_limits: hostedSearchBudgets(
                    {},
                    this.options.search,
                    this.maxRuntime - 20,
                  ),
                  cost_reporting: "unavailable",
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
        daily_execution_reserve_seconds: this.dailySeconds,
        flight_submission_enabled: !!this.options.allowSubmission,
        limitations: [
          "Hosted private profiles are not configured; optional live providers are search-only",
          "Explain requires local engine",
          "Queued jobs require explicit start; status never dispatches",
          "Execution reserves are not an account-wide billing cap",
        ],
      };
    else if (method === "query") result = await this.enqueue(params);
    else if (method === "import_table" || method === "import")
      result = await this.enqueue(params, method);
    else if (method === "read_result") result = await this.readResult(params);
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
  const enabledProviders = ["EXA", "BRAVE", "SERPER"].filter(
    (provider) => environment[`SOURCESQL_ALLOW_LIVE_${provider}`] === "1",
  );
  if (enabledProviders.length > 1)
    throw new BackendError(
      "invalid_request",
      "Choose one live search provider per Flight",
    );
  const selected = enabledProviders[0]?.toLowerCase();
  let search: HostedSearchPolicy | undefined;
  if (selected === "brave" || selected === "serper") {
    const prefix = `SOURCESQL_${selected.toUpperCase()}`;
    if (
      environment[`${prefix}_POLICY_VERSION`] !== undefined &&
      environment[`${prefix}_POLICY_VERSION`] !==
        HOSTED_SEARCH_POLICY_VERSIONS[selected]
    )
      throw new BackendError(
        "invalid_request",
        "Unsupported hosted search policy version",
      );
    search = {
      provider: selected,
      secretName: environment[`${prefix}_SECRET_NAME`] ?? "",
      approvedCostMicrousd: Number(
        environment[`${prefix}_APPROVED_COST_MICROUSD`],
      ),
      dailyCostMicrousd: Number(environment[`${prefix}_DAILY_COST_MICROUSD`]),
      requestCostMicrousd: Number(
        environment[`${prefix}_REQUEST_COST_MICROUSD`],
      ),
    };
  }
  const engine = new MotherDuckEngine({
    database: environment.MOTHERDUCK_DB ?? "",
    host: environment.MOTHERDUCK_HOST ?? "",
    token: environment.MOTHERDUCK_TOKEN ?? "",
    flightId: environment.SOURCESQL_FLIGHT_ID ?? "",
    principal,
    allowSubmission: environment.SOURCESQL_ALLOW_FLIGHT_SUBMISSION === "1",
    maxRuntimeSeconds: Number(
      environment.SOURCESQL_FLIGHT_MAX_RUNTIME_SEC ?? 120,
    ),
    dailySeconds: Number(environment.SOURCESQL_FLIGHT_DAILY_SECONDS ?? 600),
    sourceSha256: environment.SOURCESQL_FLIGHT_SOURCE_SHA256,
    requirementsSha256: environment.SOURCESQL_FLIGHT_REQUIREMENTS_SHA256,
    search,
    exa:
      environment.SOURCESQL_ALLOW_LIVE_EXA === "1"
        ? {
            approvedCostMicrousd: Number(
              environment.SOURCESQL_EXA_APPROVED_COST_MICROUSD ?? 50000,
            ),
            dailyCostMicrousd: Number(
              environment.SOURCESQL_EXA_DAILY_COST_MICROUSD ?? 1000000,
            ),
            secretName: environment.SOURCESQL_EXA_SECRET_NAME ?? "",
            policyVersion:
              environment.SOURCESQL_EXA_POLICY_VERSION ?? "exa-search.v1",
          }
        : undefined,
  });
  await engine.initialize();
  return { engine, stateBackend: new MotherDuckStateBackend(engine) };
}
