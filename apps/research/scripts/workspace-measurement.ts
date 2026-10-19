/** Offline-only measurement of the real native state backend. No credentials,
 * remote database, Flight, search or model requests are accepted by this harness. */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  MotherDuckEngine,
  MotherDuckStateBackend,
  type SqlClient,
} from "../server/motherduck.js";
import { canonicalJson } from "../server/canonical-json.js";
import { checkpointDependencyForView } from "../server/checkpoints.js";
import {
  boundedPreview,
  resultSnapshot,
  type EngineResult,
} from "../server/engine.js";
import {
  ResearchStore,
  type ResearchState,
  type ResearchStateBackend,
} from "../server/store.js";
import { effectiveValue, type Snapshot } from "../src/schema.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const workspaceLimits = {
  currentBytes: 16 * 1024 * 1024,
  historyBytes: 100 * 1024 * 1024,
} as const;
type SqlRow = Record<string, any>;
export type StorageMetrics = {
  revision: string;
  stateBytes: number;
  historyBytes: number;
  historyRows: number;
  stateHash: string;
};
export type OperationSample = StorageMetrics & {
  operation: string;
  outcome: "committed" | "unchanged" | "refused";
  wallMs: number;
  sqlCalls: number;
  resolverCalls: number;
  historyBytesAdded: number;
  currentBytesAdded: number;
  serializationProbeMs: number;
  serializedStateBytes: number;
  memory: NodeJS.MemoryUsage;
};

/** Reuses tests/helpers/motherduck-sql-server.py, the actual local DuckDB
 * transport used by MotherDuck controller tests, with one connection per client. */
export class WorkspaceHarness {
  readonly directory: string;
  private child: ChildProcessWithoutNullStreams;
  private ready: Promise<void>;
  private pending = new Map<
    string,
    { resolve: (rows: SqlRow[]) => void; reject: (error: Error) => void }
  >();
  private stderr = "";
  sqlCalls = 0;
  resolverCalls = 0;
  readonly denied = new Set<string>();
  loseCommitResponse = false;
  readonly canonical = new Map<string, Snapshot>();
  readonly engine: MotherDuckEngine;
  readonly backend: MotherDuckStateBackend;
  private constructor(directory: string) {
    this.directory = directory;
    const python =
      process.env.SOURCESQL_TEST_PYTHON ??
      process.env.SOURCESQL_PYTHON ??
      join(root, "local/python312/venv/bin/python");
    this.child = spawn(
      python,
      [
        fileURLToPath(
          new URL("../tests/helpers/motherduck-sql-server.py", import.meta.url),
        ),
        join(directory, "state.duckdb"),
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: directory,
          TMPDIR: directory,
          PYTHONDONTWRITEBYTECODE: "1",
          OPENBLAS_NUM_THREADS: "1",
          OMP_NUM_THREADS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        reject(new Error("Local workspace SQL helper did not start"));
      }, 10000);
      this.child.on("error", reject);
      createInterface({ input: this.child.stdout }).on("line", (line) => {
        const message = JSON.parse(line);
        if (message.ready) {
          clearTimeout(timer);
          resolve();
          return;
        }
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        if (message.error)
          waiting.reject(
            Object.assign(new Error(message.error.message), {
              code: message.error.code,
            }),
          );
        else waiting.resolve(message.rows);
      });
      this.child.stderr.on("data", (chunk) => {
        this.stderr = (this.stderr + String(chunk)).slice(-1000);
      });
      this.child.on("close", () => {
        clearTimeout(timer);
        const error = new Error(
          "Local workspace SQL helper closed: " + this.stderr,
        );
        reject(error);
        for (const waiting of this.pending.values()) waiting.reject(error);
        this.pending.clear();
      });
    });
    const client = (): SqlClient => {
      const connection = randomUUID();
      let wroteState = false;
      return {
        connect: async () => {
          await this.request(connection, "connect");
        },
        end: async () => {
          await this.request(connection, "end");
        },
        query: async (sql, values = []) => {
          this.sqlCalls++;
          // The safety boundary is explicit: there is no simulated Flight path.
          assert(
            !sql.includes("md_"),
            "Workspace measurements cannot call MotherDuck services",
          );
          const rows = await this.request(connection, "query", sql, values);
          if (
            /^(INSERT|UPDATE)/.test(sql) &&
            sql.includes(this.engine.table("app_state"))
          )
            wroteState = true;
          if (sql === "COMMIT" && wroteState && this.loseCommitResponse) {
            this.loseCommitResponse = false;
            throw Object.assign(
              new Error("Synthetic lost local commit acknowledgement"),
              { code: "08006" },
            );
          }
          return { rows };
        },
      };
    };
    this.engine = new MotherDuckEngine({
      database: "synthetic",
      host: "pg.us-east-1-aws.motherduck.com",
      token: "synthetic-unused",
      principal: "offline-workspace-measurement",
      flightId: "0a111111-1111-4111-a111-111111111111",
      allowSubmission: false,
      clientFactory: client,
    });
    this.backend = new MotherDuckStateBackend(this.engine);
  }
  static async create() {
    const value = new WorkspaceHarness(
      await mkdtemp(join(tmpdir(), "sourcesql-workspace-")),
    );
    await value.ready;
    await value.engine.initialize();
    return value;
  }
  private async request(
    connection: string,
    operation: string,
    sql?: string,
    values?: unknown[],
  ): Promise<SqlRow[]> {
    await this.ready;
    const id = randomUUID();
    const result = new Promise<SqlRow[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(
      JSON.stringify({
        id,
        connection_id: connection,
        operation,
        sql,
        values,
      }) + "\n",
    );
    return result;
  }
  store(seed: Snapshot, backend: ResearchStateBackend = this.backend) {
    return new ResearchStore(
      "/unused-offline-workspace",
      boundedPreview(seed),
      async (snapshot) => {
        this.resolverCalls++;
        if (this.denied.has(snapshot.id))
          throw new Error("Fixture dependency revoked");
        const canonical = this.canonical.get(snapshot.id);
        assert(canonical, "Fixture canonical result missing: " + snapshot.id);
        return {
          ...structuredClone(canonical),
          parentSnapshotId: snapshot.parentSnapshotId,
        };
      },
      3000,
      { backend },
    );
  }
  async metrics(): Promise<StorageMetrics> {
    return this.engine.connection(async (client) => {
      const current = (
        await client.query(
          `SELECT CAST(revision AS VARCHAR) AS revision,octet_length(encode(state_json))::DOUBLE AS bytes,sha256(state_json) AS hash FROM ${this.engine.table("app_state")} WHERE id=1`,
        )
      ).rows[0];
      const history = (
        await client.query(
          `SELECT count(*)::INTEGER AS rows,coalesce(sum(octet_length(encode(state_json))),0)::DOUBLE AS bytes FROM ${this.engine.table("app_state_history")}`,
        )
      ).rows[0];
      return {
        revision: current?.revision ?? "0",
        stateBytes: current?.bytes ?? 0,
        stateHash: current?.hash ?? "",
        historyRows: history.rows,
        historyBytes: history.bytes,
      };
    });
  }
  async sample(
    operation: string,
    run: () => Promise<unknown>,
  ): Promise<OperationSample> {
    const before = await this.metrics(),
      calls = this.sqlCalls,
      resolutions = this.resolverCalls;
    const started = performance.now();
    let outcome: OperationSample["outcome"];
    try {
      await run();
      outcome = "unchanged";
    } catch (error) {
      if ((error as { code?: string }).code !== "budget_exhausted") throw error;
      outcome = "refused";
    }
    const wallMs = performance.now() - started;
    const operationSqlCalls = this.sqlCalls - calls,
      resolverCalls = this.resolverCalls - resolutions;
    const after = await this.metrics();
    if (after.revision !== before.revision) outcome = "committed";
    assert.equal(
      BigInt(after.revision) - BigInt(before.revision),
      outcome === "committed" ? 1n : 0n,
    );
    assert.equal(
      after.historyRows - before.historyRows,
      outcome === "committed" ? 1 : 0,
    );
    if (outcome !== "committed")
      assert.deepEqual(
        after,
        before,
        "Read/retry/refusal cannot grow or replace state",
      );
    const state = (await this.backend.read()).state;
    // Explicitly a separate probe of the same canonical serializer, not an
    // instrumented claim about time inside the production backend write.
    const probe = performance.now(),
      serialized = state ? canonicalJson(state) : "";
    const serializationProbeMs = performance.now() - probe;
    return {
      operation,
      outcome,
      ...after,
      wallMs,
      sqlCalls: operationSqlCalls,
      resolverCalls,
      historyBytesAdded: after.historyBytes - before.historyBytes,
      currentBytesAdded: after.stateBytes - before.stateBytes,
      serializationProbeMs,
      serializedStateBytes: Buffer.byteLength(serialized),
      memory: process.memoryUsage(),
    };
  }
  async close() {
    const closed = new Promise<void>((resolve) =>
      this.child.once("close", () => resolve()),
    );
    this.child.stdin.end();
    await closed;
    await rm(this.directory, { recursive: true, force: true });
  }
}

/** Full canonical tables deliberately exceed the 100-row transport window. */
export function workspaceSnapshot(
  id: string,
  count = 205,
  primitive = false,
): Snapshot {
  const columns = primitive
    ? [
        {
          key: "label",
          label: "Entity",
          logical_type: "VARCHAR",
          nullable: false,
        },
        {
          key: "capacity",
          label: "Capacity",
          logical_type: "INTEGER",
          nullable: false,
        },
      ]
    : [
        {
          key: "label",
          label: "Entity",
          logical_type: "VARCHAR",
          nullable: true,
        },
        {
          key: "big",
          label: "Exact integer",
          logical_type: "BIGINT",
          nullable: false,
        },
        {
          key: "decimal",
          label: "Exact decimal",
          logical_type: "DECIMAL(20,4)",
          nullable: false,
        },
        {
          key: "active",
          label: "Active",
          logical_type: "BOOLEAN",
          nullable: false,
        },
        {
          key: "nullable",
          label: "Nullable",
          logical_type: "VARCHAR",
          nullable: true,
        },
        {
          key: "tags",
          label: "Tags",
          logical_type: "VARCHAR[]",
          nullable: false,
        },
        {
          key: "details",
          label: "Details",
          logical_type: "STRUCT(note VARCHAR, count BIGINT)",
          nullable: false,
        },
      ];
  const rows: EngineResult["rows"] = Array.from(
    { length: count },
    (_, index): EngineResult["rows"][number] =>
      primitive
        ? { label: "Synthetic entity", capacity: 100 }
        : {
            label: "Synthetic 東京 entity " + index,
            big: "9007199254740993",
            decimal: "1234567890123456.1234",
            active: true,
            nullable: null,
            tags: ["α", "fixture"],
            details: { note: "Unicode café", count: "9007199254740993" },
          },
  );
  const result: EngineResult = {
    result_id: "wq_" + id,
    run_id: "run_" + id,
    columns,
    rows,
    row_ids: rows.map((_, i) => "row_" + i),
    row_count: rows.length,
    next_offset: null,
    content_sha256: digest(canonicalJson({ columns, rows })),
    data_classification: "synthetic_fixture",
    evidence: [],
    source_versions: [],
    receipt: {
      status: "completed",
      finished_at: "2026-10-18T12:00:00Z",
      corpus_coverage: "bounded_fixture",
    },
  };
  return resultSnapshot(result, {
    result_id: result.result_id,
    snapshot_id: id,
    title: id,
  });
}

/** Construct linked records through supported APIs in an in-memory fixture,
 * then seed the exact state once into local native storage for measurement. */
export async function workspaceFixture(h: WorkspaceHarness, count: number) {
  assert(count === 1 || count >= 8);
  const root = workspaceSnapshot("workspace_root");
  h.canonical.set(root.id, root);
  let state: ResearchState = {
      snapshots: [boundedPreview(root)],
      amendments: [],
    },
    revision = 0;
  const backend: ResearchStateBackend = {
    async read() {
      return { state: structuredClone(state), version: String(revision) };
    },
    async write(next, expected) {
      assert.equal(expected, String(revision));
      state = structuredClone(next);
      revision++;
    },
  };
  const store = h.store(root, backend);
  let refreshReview: Parameters<ResearchStore["reviewRefresh"]>[0] | undefined;
  if (count >= 8) {
    const expansion = workspaceSnapshot("workspace_expansion");
    h.canonical.set(expansion.id, expansion);
    const expanded = {
      request_id: randomUUID(),
      snapshot_id: root.id,
      row_id: "row_204",
      question: "Synthetic expansion of the final canonical row",
    };
    await store.beginResearch(expanded, "expand");
    await store.appendResearch({
      request_id: expanded.request_id,
      snapshot: boundedPreview(expansion),
    });
    const baseline = workspaceSnapshot("workspace_refresh_base", 1, true);
    h.canonical.set(baseline.id, baseline);
    await store.import(boundedPreview(baseline));
    const refresh = {
      request_id: randomUUID(),
      snapshot_id: baseline.id,
      row_id: "row_0",
      field: "capacity",
    };
    await store.beginResearch(refresh, "refresh");
    const proposal = workspaceSnapshot("workspace_refresh", 1, true);
    proposal.rows[0].values.capacity = 200;
    proposal.rows[0].evidence.capacity = ["Synthetic entity capacity is 200."];
    h.canonical.set(proposal.id, proposal);
    await store.appendResearch({
      request_id: refresh.request_id,
      snapshot: boundedPreview(proposal),
      assessments: [
        {
          row_id: "row_0",
          field: "capacity",
          status: "verified",
          note: "Synthetic evidence",
        },
      ],
    });
    refreshReview = {
      request_id: refresh.request_id,
      row_id: "row_0",
      field: "capacity",
      decision: "accept",
      expected_revision: 0,
    };
    // Manual updates use a one-row primitive fixture, respecting the 100-row
    // first-version update boundary instead of passing the large typed table.
    const updateBase = workspaceSnapshot("workspace_update_base", 1, true);
    h.canonical.set(updateBase.id, updateBase);
    await store.import(boundedPreview(updateBase));
    const update = await store.beginUpdate({
      request_id: randomUUID(),
      snapshot_id: updateBase.id,
      expected_revision: 0,
      existing: { row_ids: ["row_0"], fields: ["capacity"] },
    });
    const observed = new Date(
        Date.parse(update.createdAt) + 1000,
      ).toISOString(),
      completed = new Date(Date.parse(update.createdAt) + 2000).toISOString();
    const updateProposal = workspaceSnapshot(
      "workspace_update_proposal",
      1,
      true,
    );
    delete updateProposal.dataRef;
    updateProposal.capturedAt = completed;
    updateProposal.rows[0].values.capacity = 200;
    const quote = "Synthetic entity capacity is 200.";
    updateProposal.rows[0].evidence.capacity = [quote];
    const saved = await store.completeUpdate(
      {
        request_id: update.id,
        existing_snapshot: updateProposal,
        assessments: [
          {
            row_id: "row_0",
            field: "capacity",
            status: "verified",
            note: "Synthetic evidence",
            observed_at: observed,
            source_version_ids: ["src_measurement"],
          },
        ],
        discovery_observations: [],
      },
      {
        [updateProposal.id]: {
          result_id: updateProposal.origin!.resultId,
          completed_at: completed,
          source_versions: [
            {
              source_version_id: "src_measurement",
              content: quote,
              content_sha256: digest(quote),
              retrieved_at: observed,
              url: "https://example.com/fixture",
              content_basis: "document",
            },
          ],
          evidence: [
            {
              evidence_id: "e_measurement",
              row_id: "row_0",
              field: "capacity",
              source_version_id: "src_measurement",
              support: [{ quote }],
            },
          ],
        },
      },
    );
    await store.reviewResearchUpdate({
      request_id: update.id,
      change_id: saved.changes![0].id,
      decision: "accept",
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    await store.publishResearchUpdate({
      request_id: update.id,
      snapshot_id: "workspace_update_accepted",
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    while (state.snapshots.length < count) {
      const next = workspaceSnapshot(
        "workspace_independent_" + state.snapshots.length,
      );
      h.canonical.set(next.id, next);
      await store.import(boundedPreview(next));
    }
  }
  await h.backend.write(state, "0");
  return { root, state, refreshReview };
}

export async function measureWorkspaceCase(
  snapshotCount: number,
  mutationTarget: number,
) {
  const h = await WorkspaceHarness.create();
  try {
    const fixture = await workspaceFixture(h, snapshotCount),
      store = h.store(fixture.root),
      samples: OperationSample[] = [];
    const initial = await h.metrics();
    let latestRetry: (() => Promise<unknown>) | undefined,
      reviewed = false;
    for (let index = 0; index < mutationTarget; index++) {
      const kind = index % 7;
      let name: string, operation: () => Promise<unknown>;
      if (kind === 2) {
        name = "checkpoint";
        const view = await store.open(fixture.root.id),
          input = {
            checkpoint_id: randomUUID(),
            snapshot_id: fixture.root.id,
            expected_revision: view.revision,
            row_ids: ["row_204"],
            question: "Continue synthetic workspace review",
            scope: "Final row; no provider calls",
          };
        const pins = (await store.dependencyViews(fixture.root.id)).map(
          (view) => checkpointDependencyForView(view),
        );
        operation = () => store.saveCheckpoint(input, pins);
        latestRetry = operation;
      } else if (snapshotCount >= 8 && (kind === 3 || kind === 4)) {
        name = kind === 3 ? "archive" : "restore";
        operation = () =>
          kind === 3
            ? store.remove("workspace_expansion")
            : store.restore("workspace_expansion");
        latestRetry = operation;
      } else if (kind === 5 && fixture.refreshReview && !reviewed) {
        name = "refresh_review";
        operation = () => store.reviewRefresh(fixture.refreshReview!);
        latestRetry = operation;
        reviewed = true;
      } else if (kind === 1 || kind === 6) {
        name = "rename";
        const view = await store.open(fixture.root.id),
          input = {
            snapshot_id: fixture.root.id,
            expected_title: view.displayTitle,
            title: "Workspace mutation " + index,
          };
        operation = () => store.rename(input);
        latestRetry = operation;
      } else {
        name = "correction";
        const view = await store.open(fixture.root.id),
          input = {
            snapshot_id: fixture.root.id,
            row_id: "row_204",
            field: "label",
            value: index === 0 ? null : "Corrected 東京 " + index,
            expected_revision: view.revision,
            mutation_id: randomUUID(),
          };
        operation = () => store.amend(input);
        latestRetry = operation;
      }
      const sample = await h.sample(name, operation);
      samples.push(sample);
      if (sample.outcome === "refused") break;
      assert.equal(
        sample.outcome,
        "committed",
        "Each counted mutation must change durable state",
      );
      samples.push(await h.sample("exact_" + name + "_retry", latestRetry));
    }
    samples.push(
      await h.sample("read_reopen_full_row", async () => {
        const reopened = await h.store(fixture.root).open(fixture.root.id);
        assert.equal(reopened.snapshot.rows.length, 205);
        assert.equal(reopened.snapshot.rows[204].id, "row_204");
        assert.equal(
          reopened.snapshot.rows[204].values.big,
          "9007199254740993",
        );
        assert.equal(
          reopened.snapshot.rows[204].values.decimal,
          "1234567890123456.1234",
        );
        assert.deepEqual(reopened.snapshot.rows[204].values.tags, [
          "α",
          "fixture",
        ]);
        assert.deepEqual(reopened.snapshot.rows[204].values.details, {
          note: "Unicode café",
          count: "9007199254740993",
        });
        assert.equal(reopened.snapshot.rows[204].values.nullable, null);
        assert.equal(
          reopened.snapshot.rows[204].values.label,
          fixture.root.rows[204].values.label,
        );
        if (
          mutationTarget &&
          samples.some(
            (sample) =>
              sample.operation === "correction" &&
              sample.outcome === "committed",
          )
        )
          assert.notEqual(
            effectiveValue(reopened, reopened.snapshot.rows[204], "label"),
            reopened.snapshot.rows[204].values.label,
          );
      }),
    );
    const title = (await store.open(fixture.root.id)).displayTitle;
    samples.push(
      await h.sample("unchanged_title", () =>
        store.rename({
          snapshot_id: fixture.root.id,
          expected_title: title,
          title,
        }),
      ),
    );
    samples.push(
      await h.sample("exact_snapshot_import", () =>
        store.import(boundedPreview(fixture.root)),
      ),
    );
    const saved = (await h.backend.read()).state!;
    if (saved.checkpoints?.[0]) {
      samples.push(
        await h.sample("exact_checkpoint_import", () =>
          store.importCheckpoint(saved.checkpoints![0].checkpoint),
        ),
      );
    }
    const final = await h.metrics();
    return {
      snapshotCount,
      mutationTarget,
      initial,
      final,
      genuineMutations: samples.filter(
        (sample) => sample.outcome === "committed",
      ).length,
      firstRefusal:
        samples.find((sample) => sample.outcome === "refused") ?? null,
      objects: {
        snapshots: saved.snapshots.length,
        amendments: saved.amendments.length,
        checkpoints: saved.checkpoints?.length ?? 0,
        requests: saved.requests?.length ?? 0,
        updates: saved.updates?.length ?? 0,
        archived: saved.archivedSnapshots?.length ?? 0,
      },
      correctionRevisions: Object.fromEntries(
        saved.snapshots.map((snapshot) => [
          snapshot.id,
          saved.amendments.filter(
            (amendment) => amendment.snapshot_id === snapshot.id,
          ).length,
        ]),
      ),
      samples,
    };
  } finally {
    await h.close();
  }
}

/** Direct boundary seeds are local backend-only fixtures. Each synthetic history
 * state is <16 MiB; their aggregate straddles the real 100 MiB allowance. */
export async function measureWorkspaceBoundaries() {
  let h = await WorkspaceHarness.create();
  try {
    const base: ResearchState = {
      snapshots: [],
      amendments: [],
      continuationContext: "",
    };
    const overhead = Buffer.byteLength(canonicalJson(base));
    const near: ResearchState = {
      ...base,
      continuationContext: "x".repeat(
        workspaceLimits.currentBytes - overhead - 1,
      ),
    };
    assert.equal(
      Buffer.byteLength(canonicalJson(near)),
      workspaceLimits.currentBytes - 1,
    );
    const currentBelowLimit = await h.sample("current_below_16_mib", () =>
      h.backend.write(near, "0"),
    );
    const currentAtLimit = await h.sample("current_at_16_mib", () =>
      h.backend.write(
        { ...near, continuationContext: near.continuationContext! + "x" },
        "1",
      ),
    );
    const currentOverLimit = await h.sample("current_over_16_mib", () =>
      h.backend.write(
        { ...near, continuationContext: near.continuationContext! + "xx" },
        "2",
      ),
    );
    // Each independent history boundary gets a fresh local database lifetime.
    // Keeping all large fixture phases in one DuckDB file retains prior pages
    // and WAL beyond the hardened container's 256 MiB /tmp allocation. This
    // removes no production data and changes neither application allowance.
    const smallBytes = Buffer.byteLength(canonicalJson(base));
    const historyCases: OperationSample[] = [];
    for (const delta of [-1, 1]) {
      await h.close();
      h = await WorkspaceHarness.create();
      await h.engine.transaction(true, async (client) => {
        await client.query(
          `INSERT INTO ${h.engine.table("app_state")} VALUES(1,7,$1)`,
          [canonicalJson(base)],
        );
        const target = workspaceLimits.historyBytes - smallBytes + delta,
          perRow = Math.floor(target / 7),
          remainder = target % 7;
        const template = canonicalJson(base),
          marker =
            template.indexOf('"continuationContext":"') +
            '"continuationContext":"'.length;
        const prefix = template.slice(0, marker),
          suffix = template.slice(marker);
        await client.query(
          `INSERT INTO ${h.engine.table("app_state_history")} SELECT i+1, $1 || repeat('x', $3 + CASE WHEN i < $4 THEN 1 ELSE 0 END - $5) || $2, '2026-10-18T12:00:00Z' FROM range(7) AS t(i)`,
          [prefix, suffix, perRow, remainder, overhead],
        );
      });
      const before = await h.metrics();
      assert.equal(
        before.historyBytes,
        workspaceLimits.historyBytes - smallBytes + delta,
      );
      historyCases.push(
        await h.sample(
          delta < 0 ? "history_below_100_mib" : "history_over_100_mib",
          () => h.backend.write(base, "7"),
        ),
      );
    }
    return {
      currentBelowLimit,
      currentAtLimit,
      currentOverLimit,
      historyCases,
    };
  } finally {
    await h.close();
  }
}
