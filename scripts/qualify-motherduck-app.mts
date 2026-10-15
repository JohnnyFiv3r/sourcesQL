/** Synthetic app-state/MCP qualification. Never submits or cancels a Flight. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  MotherDuckEngine,
  MotherDuckStateBackend,
  type SqlClient,
} from "../apps/research/server/motherduck.js";
import { ResearchStore } from "../apps/research/server/store.js";
import { createServer } from "../apps/research/server/mcp.js";
import { resolveResult } from "../apps/research/server/engine.js";
import {
  snapshotSchema,
  effectiveValue,
  type ResearchView,
} from "../apps/research/src/schema.js";
import { correctionKind } from "../apps/research/src/corrections.js";

const require = createRequire(
  new URL("../apps/research/package.json", import.meta.url),
);
const { Client: PgClient } = require("pg");
const { Client, InMemoryTransport } = require("@modelcontextprotocol/client");
const setup = JSON.parse(
  readFileSync("local/motherduck/hosted-setup.json", "utf8"),
);
const qualificationDirectory = resolve("artifacts/hosted-storage-20261014");
mkdirSync(qualificationDirectory, { recursive: true });
const path = resolve(qualificationDirectory, "app-receipt.json");
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, ordered(item)]),
        )
      : value;
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(ordered(value)))
    .digest("hex");
const principal = "hosted-qualification";
const seed = snapshotSchema.parse(
  JSON.parse(
    readFileSync("apps/research/fixtures/water-procurement.json", "utf8"),
  ),
);
const fixtureOnly = process.argv.includes("--fixture");
const nativeReceipt = JSON.parse(
  readFileSync(resolve(qualificationDirectory, "receipt.json"), "utf8"),
);
const completed = Object.entries(nativeReceipt.jobs ?? {})
  .map(([name, entry]: [string, any]) => ({
    name,
    ...entry,
    observed: entry.status ?? entry.submission,
  }))
  .filter(
    (entry: any) =>
      entry.observed?.status === "completed" &&
      entry.observed.result_id &&
      entry.observed.job_id,
  )
  .sort((a: any, b: any) =>
    String(b.observed.updated_at ?? "").localeCompare(
      String(a.observed.updated_at ?? ""),
    ),
  )[0] as any;
const subject = fixtureOnly
  ? {
      snapshot_id: "hosted-app-fixture-qualification",
      mode: "synthetic_app_fixture",
    }
  : completed
    ? {
        snapshot_id: "hosted-app-" + completed.observed.job_id,
        mode: "completed_engine_result",
        job_id: completed.observed.job_id,
        result_id: completed.observed.result_id,
      }
    : undefined;
let receipt: any;
try {
  receipt = JSON.parse(readFileSync(path, "utf8"));
} catch (error: any) {
  if (error.code !== "ENOENT") throw error;
}
receipt ??= {
  schema: "sourcesql.hosted-app-qualification.v1",
  created_at: new Date().toISOString(),
  checks: {},
  calls: {},
  provider_calls: 0,
  flight_submissions: 0,
};
const save = () =>
  writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
const check = (condition: unknown, code: string) => {
  if (!condition) throw Object.assign(new Error(code), { code });
};
let forbiddenControls = 0,
  sqlConnections = 0,
  controlReads = 0;
const sessions: { close: () => Promise<void> }[] = [];

try {
  check(subject, "completed_result_not_ready");
  if (receipt.subject)
    check(
      JSON.stringify(receipt.subject) === JSON.stringify(subject),
      "qualification_subject_changed",
    );
  receipt.subject = subject;
  receipt.attempted_at = new Date().toISOString();
  save();
  // Keep the issuer's existing credential in process memory; never put it in argv or logs.
  const token = JSON.parse(
    readFileSync(`${homedir()}/.motherduck/credentials.json`, "utf8"),
  ).motherduck_token;
  const clientFactory = (): SqlClient => {
    const client = new PgClient({
      host: setup.host,
      port: 5432,
      database: setup.database,
      user: "user",
      password: token,
      ssl: { rejectUnauthorized: true },
      connectionTimeoutMillis: 5000,
      query_timeout: 30000,
    });
    return {
      connect: async () => {
        sqlConnections++;
        await client.connect();
      },
      end: () => client.end(),
      query: async (sql, values) => {
        const controls = sql.match(/\bmd_[a-z_]*flight[a-z_]*(?=\s*\()/g) ?? [];
        for (const name of controls) {
          if (!["md_get_flight_run", "md_list_flight_runs"].includes(name)) {
            forbiddenControls++;
            throw Object.assign(
              new Error("Flight mutation forbidden in app qualification"),
              { code: "flight_mutation_forbidden" },
            );
          }
          controlReads++;
        }
        return client.query(sql, values);
      },
    };
  };
  const engine = () =>
    new MotherDuckEngine({
      database: setup.database,
      host: setup.host,
      token,
      flightId: setup.flight_id,
      principal,
      allowSubmission: false,
      clientFactory,
    });
  const connect = async () => {
    const backendEngine = engine();
    await backendEngine.initialize();
    const backend = new MotherDuckStateBackend(backendEngine);
    const store = new ResearchStore(
      resolve("local/motherduck/unused-app-state"),
      seed,
      async (snapshot) => {
        check(snapshot.dataRef, "missing_engine_reference");
        const canonical = await resolveResult(backendEngine, {
          result_id: snapshot.dataRef!.resultId,
          snapshot_id: snapshot.id,
          title: snapshot.title,
        });
        check(
          canonical.dataRef!.contentSha256 ===
            snapshot.dataRef!.contentSha256 &&
            canonical.origin!.runId === snapshot.origin!.runId &&
            canonical.rowCount === snapshot.rowCount &&
            JSON.stringify(canonical.columns) ===
              JSON.stringify(snapshot.columns) &&
            canonical.capturedAt === snapshot.capturedAt,
          "canonical_reference_mismatch",
        );
        return { ...canonical, parentSnapshotId: snapshot.parentSnapshotId };
      },
      3000,
      { backend },
    );
    const server = createServer(
      store,
      resolve("apps/research/dist/research.html"),
      {
        engine: backendEngine,
        access: { mode: "protected", principal, allowPrivateDisclosure: false },
      },
    );
    const client = new Client({
      name: "sourcesql-hosted-app-qualification",
      version: "1",
    });
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const session = {
      backendEngine,
      backend,
      store,
      client,
      async close() {
        await client.close();
        await server.close();
      },
    };
    sessions.push(session);
    return session;
  };
  const first = await connect();
  const call = async (
    session: Awaited<ReturnType<typeof connect>>,
    name: string,
    args: Record<string, unknown>,
    allowError = false,
  ) => {
    receipt.calls[name] = (receipt.calls[name] ?? 0) + 1;
    const response = await session.client.callTool({ name, arguments: args });
    if (!allowError) check(!response.isError, "mcp_" + name + "_failed");
    return response;
  };
  if (subject!.mode === "completed_engine_result") {
    const status = await call(first, "sourcesql_job_status", {
      job_id: subject!.job_id,
    });
    check(
      status.structuredContent.status === "completed" &&
        status.structuredContent.result_id === subject!.result_id,
      "completed_job_mismatch",
    );
    const page = await call(first, "sourcesql_read_result", {
      result_id: subject!.result_id,
      offset: 0,
      limit: 100,
    });
    check(
      page.structuredContent.result_id === subject!.result_id &&
        page.structuredContent.row_count > 0,
      "stored_result_unavailable",
    );
    receipt.checks.completed_job_tool = true;
    receipt.checks.stored_result_tool = true;
    receipt.checks.row_count = page.structuredContent.row_count;
  }
  const before = await first.backend.read();
  const opened = await call(
    first,
    "open_research",
    subject!.mode === "completed_engine_result"
      ? {
          result_ref: {
            result_id: subject!.result_id,
            snapshot_id: subject!.snapshot_id,
            title: "Hosted synthetic qualification research",
          },
        }
      : {
          snapshot: {
            ...seed,
            id: subject!.snapshot_id,
            title: "Hosted synthetic qualification fixture",
          },
        },
  );
  const view = await first.store.open(
    (opened.structuredContent as ResearchView).snapshot.id,
  );
  check(view.snapshot.rows.length > 0, "empty_qualification_snapshot");
  if (!receipt.correction) {
    const row = view.snapshot.rows[0];
    const column = [...view.snapshot.columns]
      .sort(
        (a, b) =>
          Number(["url", "source_url"].includes(a.key)) -
          Number(["url", "source_url"].includes(b.key)),
      )
      .find((candidate) =>
        ["text", "number", "integer_string", "boolean"].includes(
          correctionKind(view, row, candidate.key),
        ),
      );
    check(column, "no_supported_scalar_for_correction");
    const kind = correctionKind(view, row, column!.key),
      original = row.values[column!.key];
    const value =
      kind === "number"
        ? Number(original ?? 0) + 1
        : kind === "integer_string"
          ? (BigInt(String(original ?? "0")) + 1n).toString()
          : kind === "boolean"
            ? !original
            : "Synthetic durable correction";
    check(
      JSON.stringify(value) !== JSON.stringify(original),
      "correction_must_change_value",
    );
    receipt.correction = {
      snapshot_id: subject!.snapshot_id,
      row_id: row.id,
      field: column!.key,
      value,
      expected_revision: view.revision,
      mutation_id: randomUUID(),
    };
    receipt.stale_mutation_id = randomUUID();
    receipt.original_rows_sha256 = digest(view.snapshot.rows);
    receipt.original_content_sha256 =
      view.snapshot.dataRef?.contentSha256 ?? null;
    receipt.before_state_revision = before.version;
    save();
  }
  const corrected = await call(first, "amend_observation", receipt.correction);
  const correctedView = corrected.structuredContent as ResearchView;
  check(
    correctedView.revision === receipt.correction.expected_revision + 1,
    "correction_revision_mismatch",
  );
  const committed = await first.backend.read();
  receipt.after_state_revision = committed.version;
  check(
    digest((await first.store.open(subject!.snapshot_id)).snapshot.rows) ===
      receipt.original_rows_sha256,
    "original_observation_changed",
  );
  const retry = await call(first, "amend_observation", receipt.correction);
  check(
    (retry.structuredContent as ResearchView).revision ===
      correctedView.revision,
    "mutation_retry_changed_revision",
  );
  check(
    (await first.backend.read()).version === committed.version,
    "mutation_retry_rewrote_state",
  );
  const stale = await call(
    first,
    "amend_observation",
    { ...receipt.correction, mutation_id: receipt.stale_mutation_id },
    true,
  );
  check(stale.isError === true, "stale_correction_not_refused");
  check(
    (await first.backend.read()).version === committed.version,
    "stale_correction_wrote_state",
  );
  const reopened = await connect();
  const restored = await call(reopened, "open_research", {
    snapshot_id: subject!.snapshot_id,
  });
  const restoredView = await reopened.store.open(
    (restored.structuredContent as ResearchView).snapshot.id,
  );
  const row = restoredView.snapshot.rows.find(
    (item) => item.id === receipt.correction.row_id,
  )!;
  check(
    JSON.stringify(
      effectiveValue(restoredView, row, receipt.correction.field),
    ) === JSON.stringify(receipt.correction.value),
    "fresh_backend_lost_correction",
  );
  check(
    digest(restoredView.snapshot.rows) === receipt.original_rows_sha256,
    "fresh_backend_changed_original",
  );
  const full = restoredView;
  const history = await reopened.backendEngine.connection(
    async (client) =>
      (
        await client.query(
          `SELECT CAST(revision AS VARCHAR) AS revision,state_json FROM ${reopened.backendEngine.table("app_state_history")} WHERE revision=$1::BIGINT`,
          [committed.version],
        )
      ).rows[0],
  );
  check(history, "history_revision_missing");
  const historical = JSON.parse(history.state_json);
  check(
    historical.amendments.some(
      (entry: any) => entry.mutation_id === receipt.correction.mutation_id,
    ),
    "historical_correction_missing",
  );
  check(
    digest(
      historical.snapshots.find(
        (snapshot: any) => snapshot.id === subject!.snapshot_id,
      ).rows,
    ) === receipt.original_rows_sha256,
    "history_changed_original",
  );
  if (subject!.mode === "completed_engine_result") {
    const canonical = await resolveResult(reopened.backendEngine, {
      result_id: subject!.result_id!,
      snapshot_id: subject!.snapshot_id,
      title: full.snapshot.title,
    });
    check(
      digest(canonical.rows) === receipt.original_rows_sha256,
      "app_correction_changed_engine_result",
    );
    check(
      canonical.dataRef!.contentSha256 === receipt.original_content_sha256,
      "engine_content_hash_changed",
    );
    receipt.checks.canonical_engine_data_unchanged = true;
  }
  check(forbiddenControls === 0, "flight_mutation_attempted");
  receipt.checks = {
    ...receipt.checks,
    saved_root: true,
    correction_persisted: true,
    exact_mutation_retry_idempotent: true,
    stale_revision_refused: true,
    original_observations_unchanged: true,
    fresh_backend_reopen: true,
    correction_history_retained: true,
    original_content_hash: receipt.original_content_sha256,
    amendment_revision: restoredView.revision,
    sql_connections: sqlConnections,
    read_only_flight_control_calls: controlReads,
    forbidden_flight_mutations: forbiddenControls,
  };
  receipt.completed_at = new Date().toISOString();
  receipt.last_failure = undefined;
  save();
  console.log(
    JSON.stringify({
      schema: receipt.schema,
      passed: true,
      mode: subject!.mode,
      checks: receipt.checks,
      provider_calls: 0,
      flight_submissions: 0,
      receipt: "artifacts/hosted-storage-20261014/app-receipt.json",
    }),
  );
} catch (error: any) {
  receipt.last_failure = {
    at: new Date().toISOString(),
    code: String(error.code ?? error.name ?? "qualification_failed")
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 80),
  };
  receipt.forbidden_flight_mutations = forbiddenControls;
  save();
  console.error(
    JSON.stringify({
      schema: receipt.schema,
      failed: true,
      code: receipt.last_failure.code,
      flight_submissions: 0,
      provider_calls: 0,
    }),
  );
  process.exitCode = 1;
} finally {
  for (const session of sessions.reverse())
    await session.close().catch(() => undefined);
}
