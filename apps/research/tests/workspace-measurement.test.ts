import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  measureWorkspaceCase,
  measureWorkspaceBoundaries,
  WorkspaceHarness,
  workspaceFixture,
  workspaceLimits,
} from "../scripts/workspace-measurement.js";
import type { ResearchStateBackend } from "../server/store.js";
import { checkpointDependencyForView } from "../server/checkpoints.js";
import { effectiveValue } from "../src/schema.js";

test("native workspace growth preserves full typed rows and exact retries do not grow history", async () => {
  const result = await measureWorkspaceCase(8, 14);
  assert.equal(result.genuineMutations, 14);
  assert.equal(result.final.historyRows - result.initial.historyRows, 14);
  assert.equal(
    BigInt(result.final.revision) - BigInt(result.initial.revision),
    14n,
  );
  assert.equal(result.objects.snapshots, 8);
  assert(result.objects.updates > 0);
  assert(result.objects.requests >= 2);
  assert(
    result.samples.some(
      (sample) =>
        sample.operation === "refresh_review" && sample.outcome === "committed",
    ),
  );
  assert(
    result.samples.some(
      (sample) =>
        sample.operation === "checkpoint" && sample.outcome === "committed",
    ),
  );
  for (const sample of result.samples.filter(
    (sample) =>
      sample.operation.startsWith("exact_") ||
      sample.operation === "unchanged_title" ||
      sample.operation === "read_reopen_full_row",
  )) {
    assert.equal(sample.outcome, "unchanged", sample.operation);
    assert.equal(sample.historyBytesAdded, 0, sample.operation);
  }
});

test("native workspace uses real 16 MiB current and 100 MiB history boundaries with atomic refusal", async () => {
  const result = await measureWorkspaceBoundaries();
  assert.equal(result.currentBelowLimit.outcome, "committed");
  assert.equal(
    result.currentBelowLimit.stateBytes,
    workspaceLimits.currentBytes - 1,
  );
  assert.equal(result.currentAtLimit.outcome, "committed");
  assert.equal(result.currentAtLimit.stateBytes, workspaceLimits.currentBytes);
  assert.equal(result.currentOverLimit.outcome, "refused");
  assert.equal(result.historyCases[0].outcome, "committed");
  assert.equal(
    result.historyCases[0].historyBytes,
    workspaceLimits.historyBytes - 1,
  );
  assert.equal(result.historyCases[1].outcome, "refused");
});

test("native workspace stale writers and lost acknowledgements retain one mutation and history record", async () => {
  const h = await WorkspaceHarness.create();
  try {
    const { root } = await workspaceFixture(h, 1);
    const inputs = [null, "Competing value"].map((value) => ({
      snapshot_id: root.id,
      row_id: "row_204",
      field: "label",
      value,
      expected_revision: 0,
      mutation_id: randomUUID(),
    }));
    let reads = 0,
      release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const racing: ResearchStateBackend = {
      async read() {
        const value = await h.backend.read();
        if (++reads <= 2) {
          if (reads === 2) release();
          await barrier;
        }
        return value;
      },
      write: (state, version) => h.backend.write(state, version),
    };
    const before = await h.metrics();
    const outcomes = await Promise.allSettled(
      inputs.map((input) => h.store(root, racing).amend(input)),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    const after = await h.metrics();
    assert.equal(after.historyRows, before.historyRows + 1);
    assert.equal(BigInt(after.revision), BigInt(before.revision) + 1n);
    const amendment = {
      ...inputs[0],
      expected_revision: 1,
      mutation_id: randomUUID(),
      value: "Recovered exact mutation",
    };
    h.loseCommitResponse = true;
    await assert.rejects(h.store(root).amend(amendment), {
      code: "storage_unavailable",
    });
    const lost = await h.metrics();
    const recovered = await h.store(root).amend(amendment);
    assert.equal(recovered.revision, 2);
    assert.deepEqual(await h.metrics(), lost);
  } finally {
    await h.close();
  }
});

test("native workspace reads authorize selected sources and revocation still blocks dependent opens", async () => {
  const h = await WorkspaceHarness.create();
  try {
    const { root, refreshReview } = await workspaceFixture(h, 8),
      store = h.store(root);
    await store.reviewRefresh(refreshReview!);
    h.denied.add("workspace_independent_7");
    const before = await h.metrics();
    assert.equal((await store.open("workspace_refresh_base")).revision, 1);
    h.denied.add("workspace_refresh");
    await assert.rejects(store.open("workspace_refresh_base"), /revoked/);
    assert.deepEqual(await h.metrics(), before);
  } finally {
    await h.close();
  }
});

test("native workspace portable export/import preserves final-row corrections, checkpoints and reviewed updates", async () => {
  const source = await WorkspaceHarness.create(),
    destination = await WorkspaceHarness.create();
  try {
    const { root, refreshReview } = await workspaceFixture(source, 8),
      store = source.store(root);
    await store.reviewRefresh(refreshReview!);
    await store.amend({
      snapshot_id: root.id,
      row_id: "row_204",
      field: "label",
      value: null,
      expected_revision: 0,
      mutation_id: randomUUID(),
    });
    const view = await store.open(root.id);
    const checkpoint = await store.saveCheckpoint(
      {
        checkpoint_id: randomUUID(),
        snapshot_id: root.id,
        expected_revision: view.revision,
        row_ids: ["row_204"],
        question: "Preserve full canonical row",
        scope: "Synthetic portable workspace",
      },
      (await store.dependencyViews(root.id)).map((view) =>
        checkpointDependencyForView(view),
      ),
    );
    for (const [id, snapshot] of source.canonical)
      destination.canonical.set(id, snapshot);
    const restored = destination.store(root);
    const rootBundle = await store.exportBundle(root.id);
    await restored.importBundle(rootBundle);
    const beforeRetry = await destination.metrics();
    await restored.importBundle(rootBundle);
    assert.deepEqual(
      await destination.metrics(),
      beforeRetry,
      "An exact authorized portable bundle retry must not append another state/history revision",
    );
    const reopened = await restored.open(root.id);
    assert.equal(reopened.snapshot.rows.length, 205);
    assert.equal(reopened.revision, 1);
    assert.equal(
      effectiveValue(reopened, reopened.snapshot.rows[204], "label"),
      null,
    );
    assert.equal(
      reopened.snapshot.rows[204].values.label,
      root.rows[204].values.label,
    );
    assert.deepEqual(
      (await restored.readCheckpoint(checkpoint.id)).checkpoint,
      checkpoint,
    );
    const refreshBundle = await store.exportBundle("workspace_refresh_base");
    await restored.importBundle(refreshBundle);
    assert.equal((await restored.open("workspace_refresh_base")).revision, 1);
    await restored.importBundle(
      await store.exportBundle("workspace_update_accepted"),
    );
    assert.equal(
      (await restored.open("workspace_update_accepted")).snapshot.rows[0].values
        .capacity,
      200,
    );
    assert.equal(
      (await restored.open("workspace_update_accepted")).update!.decisions[
        Object.keys(
          (await restored.open("workspace_update_accepted")).update!.decisions,
        )[0]
      ],
      "accept",
    );
    const beforeRevocation = await destination.metrics();
    destination.denied.add("workspace_refresh");
    await assert.rejects(restored.importBundle(refreshBundle), /revoked/);
    assert.deepEqual(await destination.metrics(), beforeRevocation);
  } finally {
    await source.close();
    await destination.close();
  }
});
