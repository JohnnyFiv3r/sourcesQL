import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ResearchStore,
  type ResearchState,
  type ResearchStateBackend,
} from "../server/store.js";
import { snapshotSchema, effectiveValue } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
import {
  boundedPreview,
  resultSnapshot,
  type EngineResult,
} from "../server/engine.js";

const seed = snapshotSchema.parse(sample);
class MemoryBackend implements ResearchStateBackend {
  state?: ResearchState;
  version = 0;
  writes = 0;
  async read() {
    return {
      state: structuredClone(this.state),
      version: String(this.version),
    };
  }
  async write(state: ResearchState, expectedVersion: string) {
    this.writes++;
    if (expectedVersion !== String(this.version))
      throw new Error(
        "Durable research revision conflict; reload before retrying",
      );
    this.state = structuredClone(state);
    this.version++;
  }
}
const store = (backend: ResearchStateBackend, directory = "/not-used") =>
  new ResearchStore(directory, seed, undefined, 3000, { backend });
const amendment = (value: string | null) => ({
  snapshot_id: seed.id,
  row_id: seed.rows[0].id,
  field: "closes_at",
  value,
  expected_revision: 0,
  mutation_id: randomUUID(),
});

test("durable store reopens original evidence, amendments and titles from a new instance", async () => {
  const backend = new MemoryBackend();
  const first = store(backend);
  await first.amend(amendment(null));
  await first.rename({
    snapshot_id: seed.id,
    expected_title: seed.title,
    title: "Saved research",
  });
  const reopened = await store(backend).open(seed.id);
  assert.equal(reopened.displayTitle, "Saved research");
  assert.equal(reopened.revision, 1);
  assert.equal(
    reopened.snapshot.rows[0].values.closes_at,
    seed.rows[0].values.closes_at,
  );
  assert.equal(
    effectiveValue(reopened, reopened.snapshot.rows[0], "closes_at"),
    null,
  );
  assert.equal(backend.writes, 2);
});

test("two durable writers CAS one correction and refuse the competing stale write", async () => {
  const backend = new MemoryBackend();
  let readCount = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const racingBackend: ResearchStateBackend = {
    async read() {
      const value = await backend.read();
      if (++readCount <= 2) {
        if (readCount === 2) release();
        await barrier;
      }
      return value;
    },
    write: (state, version) => backend.write(state, version),
  };
  const inputs = [amendment(null), amendment("2026-10-08 15:00:00")];
  const outcomes = await Promise.allSettled(
    inputs.map((input) => store(racingBackend).amend(input)),
  );
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.match(
    String(
      (
        outcomes.find(
          (outcome) => outcome.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ),
    /revision conflict/i,
  );
  const reopened = await store(backend).open(seed.id);
  assert.equal(reopened.amendments.length, 1);
  assert.equal(reopened.revision, 1);
  assert.equal(
    backend.writes,
    2,
    "A CAS conflict is not automatically retried",
  );
});

test("a lost durable write response recovers the exact mutation without rewriting", async () => {
  const backend = new MemoryBackend();
  const lostResponseBackend: ResearchStateBackend = {
    read: () => backend.read(),
    async write(state, version) {
      await backend.write(state, version);
      throw new Error("Synthetic lost commit response");
    },
  };
  const input = amendment(null);
  await assert.rejects(
    store(lostResponseBackend).amend(input),
    /lost commit response/,
  );
  assert.equal((await store(backend).amend(input)).revision, 1);
  assert.equal(backend.writes, 1);
  await assert.rejects(
    store(backend).amend({ ...input, value: "2026-10-08 15:00:00" }),
    /Mutation ID already used/,
  );
  await assert.rejects(
    store(backend).amend(amendment(null)),
    /changed.*Reload/i,
  );
  assert.equal(backend.writes, 1);
});

test("durable state does not use or recover an unrelated filesystem crash lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-backend-lock-"));
  const owner = join(directory, ".writer-lock", "owner-old.json");
  try {
    await mkdir(join(directory, ".writer-lock"));
    await writeFile(owner, "existing lock");
    const backend = new MemoryBackend();
    await store(backend, directory).amend(amendment(null));
    assert.equal(await readFile(owner, "utf8"), "existing lock");
    await assert.rejects(readFile(join(directory, "research.json")), {
      code: "ENOENT",
    });
    assert.equal(backend.version, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unavailable or corrupt durable reads fail instead of reseeding or writing", async () => {
  let writes = 0;
  const unavailable: ResearchStateBackend = {
    async read() {
      throw new Error("Synthetic durable read unavailable");
    },
    async write() {
      writes++;
    },
  };
  await assert.rejects(store(unavailable).open(), /read unavailable/);
  await assert.rejects(
    store(unavailable).amend(amendment(null)),
    /read unavailable/,
  );
  const corrupt: ResearchStateBackend = {
    async read() {
      return { state: {} as ResearchState, version: "1" };
    },
    async write() {
      writes++;
    },
  };
  await assert.rejects(store(corrupt).open(), /invalid.*explicit recovery/);
  const invalidVersion: ResearchStateBackend = {
    async read() {
      return { version: "" };
    },
    async write() {
      writes++;
    },
  };
  await assert.rejects(
    store(invalidVersion).amend(amendment(null)),
    /invalid version/,
  );
  assert.equal(writes, 0);
});

test("durable engine-backed state reopens and corrects canonical rows beyond the transport preview", async () => {
  const backend = new MemoryBackend();
  const result: EngineResult = {
    result_id: "wq_large_durable",
    run_id: "run_large_durable",
    columns: [
      { key: "value", label: "Value", logical_type: "BIGINT", nullable: false },
    ],
    rows: Array.from({ length: 205 }, (_, index) => ({ value: String(index) })),
    row_ids: Array.from({ length: 205 }, (_, index) => "row_" + index),
    row_count: 205,
    content_sha256: "a".repeat(64),
    data_classification: "synthetic_fixture",
    evidence: [],
    source_versions: [],
    receipt: { status: "completed", finished_at: "2026-10-14T16:00:00Z" },
    next_offset: null,
  };
  const canonical = resultSnapshot(result, {
    result_id: result.result_id,
    snapshot_id: "large-durable",
    title: "Large durable result",
  });
  const fresh = () =>
    new ResearchStore(
      "/unused",
      seed,
      async (snapshot) => {
        assert.equal(snapshot.dataRef!.resultId, result.result_id);
        assert.equal(snapshot.dataRef!.contentSha256, result.content_sha256);
        return structuredClone(canonical);
      },
      3000,
      { backend },
    );
  const preview = boundedPreview(canonical);
  assert.equal(preview.rows.length, 100);
  await fresh().import(preview);
  assert.equal((await fresh().open(canonical.id)).snapshot.rows.length, 205);
  await fresh().amend({
    snapshot_id: canonical.id,
    row_id: "row_204",
    field: "value",
    value: "999",
    expected_revision: 0,
    mutation_id: randomUUID(),
  });
  const reopened = await fresh().open(canonical.id);
  assert.equal(reopened.snapshot.rows.length, 205);
  assert.equal(reopened.snapshot.rows[204].values.value, "204");
  assert.equal(
    effectiveValue(reopened, reopened.snapshot.rows[204], "value"),
    "999",
  );
  assert.equal(reopened.revision, 1);
});
