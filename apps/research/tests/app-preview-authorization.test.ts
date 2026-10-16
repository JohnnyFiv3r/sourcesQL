import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResearchApplication } from "../server/app.js";
import {
  resultSnapshot,
  type EngineResult,
  type ResearchEngine,
} from "../server/engine.js";
import type { ResearchState, ResearchStateBackend } from "../server/store.js";
import type { Snapshot } from "../src/schema.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const reference = (id: string) => ({
  result_id: `wq_${id}`,
  snapshot_id: `saved_${id}`,
  title: `Saved ${id}`,
});
function result(id: string, legacy = false): EngineResult {
  return {
    result_id: `wq_${id}`,
    run_id: `run_${id}`,
    row_ids: [`row_${id}`],
    row_count: 1,
    columns: [
      {
        key: "project",
        label: "Project",
        logical_type: "VARCHAR",
        nullable: false,
      },
      {
        key: "capacity",
        label: "Capacity",
        logical_type: "VARCHAR",
        nullable: true,
      },
      { key: "facts", label: "Facts", logical_type: "JSON", nullable: false },
    ],
    rows: [
      {
        project: "Aurora Campus",
        capacity: "500 MW",
        facts: { zeta: [1, null], alpha: true },
      },
    ],
    content_sha256: "a".repeat(64),
    data_classification: "public_web",
    next_offset: null,
    receipt: { status: "completed", finished_at: "2026-10-16T10:00:00Z" },
    source_versions: [
      {
        source_version_id: "src_capacity",
        url: "https://source.example/campus",
      },
    ],
    evidence: [
      {
        evidence_id: "e_capacity",
        row_id: `row_${id}`,
        ...(legacy ? { field: "capacity" } : { column_key: "capacity" }),
        source_version_id: "src_capacity",
        status: "supported_text",
        support: [{ quote: "500 MW" }],
      },
    ],
  };
}
function savedLegacy(): Snapshot {
  const snapshot = resultSnapshot(result("legacy", true), reference("legacy"));
  // This is the previously persisted server rendering of field-only evidence.
  delete snapshot.rows[0].cellSources;
  snapshot.rows[0].sourceUrl = "https://source.example/campus";
  snapshot.rows[0].sources = [{ url: "https://source.example/campus" }];
  snapshot.rows[0].evidence = { capacity: ["500 MW"] };
  snapshot.rows[0].verificationNote =
    "Direct textual support; not a truth guarantee.";
  return snapshot;
}
class Backend implements ResearchStateBackend {
  revision = 0;
  constructor(public state: ResearchState) {}
  async read() {
    return {
      state: structuredClone(this.state),
      version: String(this.revision),
    };
  }
  async write(state: ResearchState, expected: string) {
    assert.equal(expected, String(this.revision));
    this.state = structuredClone(state);
    this.revision++;
  }
}
class Engine implements ResearchEngine {
  denied = new Set<string>();
  calls: string[] = [];
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push(method);
    assert.equal(
      method,
      "read_result",
      "Reauthorization must not submit new work",
    );
    const id = String(params.result_id);
    if (this.denied.has(id)) throw new Error("Canonical access revoked");
    assert.ok(["wq_legacy", "wq_current"].includes(id));
    return structuredClone(
      result(id === "wq_legacy" ? "legacy" : "current", id === "wq_legacy"),
    ) as T;
  }
}
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-preview-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backend = new Backend({ snapshots: [savedLegacy()], amendments: [] }),
    engine = new Engine();
  const factory = () =>
    createResearchApplication({
      root,
      serverless: true,
      environment: {
        RESEARCH_AUTH_MODE: "protected",
        SOURCESQL_BACKEND: "motherduck",
        SOURCESQL_PRINCIPAL: "preview-test",
        RESEARCH_BEARER_TOKEN: "synthetic-" + "a".repeat(40),
        RESEARCH_DATA_DIR: directory,
      },
      backend: { engine, stateBackend: backend },
    });
  return { backend, engine, factory };
}

test("saved legacy rendering is recomputed only after immutable values and engine authority match", async (t) => {
  const { backend, engine, factory } = await fixture(t);
  const original = structuredClone(backend.state);
  const app = await factory();
  // The same stale rendering is not trusted when supplied through public import.
  await assert.rejects(
    app.store.import(savedLegacy()),
    /preview does not match canonical/,
  );
  assert.equal(backend.revision, 0);
  const reopened = await app.store.open("saved_legacy");
  assert.deepEqual(
    reopened.snapshot.rows[0].values,
    original.snapshots[0].rows[0].values,
  );
  assert.deepEqual(reopened.snapshot.rows[0].cellSources, {});
  assert.deepEqual(reopened.snapshot.rows[0].evidence, {});
  assert.equal(reopened.snapshot.rows[0].sourceUrl, null);
  assert.doesNotMatch(
    reopened.snapshot.rows[0].verificationNote,
    /Direct textual support/,
  );
  assert.equal(
    backend.revision,
    0,
    "A read does not silently overwrite historical state",
  );
  await app.store.import(
    resultSnapshot(result("current"), reference("current")),
  );
  assert.equal(backend.revision, 1);
  assert.equal(backend.state.snapshots.length, 2);
  assert.deepEqual(
    backend.state.snapshots.find((s) => s.id === "saved_legacy")!.rows[0]
      .cellSources,
    {},
  );
  assert.deepEqual(original.snapshots[0].rows[0].evidence, {
    capacity: ["500 MW"],
  });
  assert.ok(engine.calls.every((method) => method === "read_result"));
});

test("public imports still reject changed values, citations and result metadata before any write", async (t) => {
  const { backend, factory } = await fixture(t);
  const app = await factory(),
    canonical = resultSnapshot(result("current"), reference("current"));
  const changes: ((snapshot: Snapshot) => void)[] = [
    (s) => {
      s.rows[0].values.capacity = "900 MW";
    },
    (s) => {
      s.rows[0].evidence.capacity = ["Invented citation"];
    },
    (s) => {
      s.rows[0].cellSources!.capacity = [{ url: "https://forged.example/" }];
    },
    (s) => {
      s.rows[0].sourceUrl = "https://forged.example/";
    },
    (s) => {
      s.rows[0].verificationNote = "Unqualified certainty";
    },
    (s) => {
      s.dataRef!.contentSha256 = "b".repeat(64);
    },
    (s) => {
      s.columns[0].label = "Forged label";
    },
  ];
  for (const change of changes) {
    const altered = structuredClone(canonical);
    change(altered);
    await assert.rejects(app.store.import(altered), /does not match canonical/);
    assert.equal(backend.revision, 0);
  }
  await assert.rejects(
    app.store.import({ ...canonical, source: "saved_state" }),
  );
  assert.equal(backend.revision, 0);
});

test("saved rendering upgrades never excuse changed immutable data or revoked engine access", async (t) => {
  const { backend, engine, factory } = await fixture(t);
  const original = structuredClone(backend.state);
  for (const change of [
    (s: Snapshot) => {
      s.rows[0].values.capacity = "900 MW";
    },
    (s: Snapshot) => {
      s.rows[0].id = "other_row";
    },
    (s: Snapshot) => {
      s.dataRef!.contentSha256 = "b".repeat(64);
    },
    (s: Snapshot) => {
      s.origin!.runId = "run_other";
    },
    (s: Snapshot) => {
      s.columns[0].label = "Forged label";
    },
    (s: Snapshot) => {
      s.capturedAt = "2026-10-16T11:00:00Z";
    },
  ]) {
    backend.state = structuredClone(original);
    change(backend.state.snapshots[0]);
    await assert.rejects(
      (await factory()).store.open("saved_legacy"),
      /does not match canonical/,
    );
    assert.equal(backend.revision, 0);
  }
  backend.state = structuredClone(original);
  // Object-key order is JSON decoration, while array order and values stay fixed.
  backend.state.snapshots[0].rows[0].values.facts = {
    alpha: true,
    zeta: [1, null],
  };
  await (await factory()).store.open("saved_legacy");
  engine.denied.add("wq_legacy");
  await assert.rejects(
    (await factory()).store.open("saved_legacy"),
    /Canonical access revoked/,
  );
  assert.equal(backend.revision, 0);
});
