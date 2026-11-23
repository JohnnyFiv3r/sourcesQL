import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ResearchStore } from "../server/store.js";
import { PythonEngine } from "../server/engine.js";
import { snapshotSchema, effectiveValue } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
const seed = snapshotSchema.parse(sample);
function amendment(value: string | null) {
  return {
    snapshot_id: seed.id,
    row_id: seed.rows[0].id,
    field: "closes_at",
    value,
    expected_revision: 0,
    mutation_id: randomUUID(),
  };
}
test("independent store writers reread revisions under an atomic filesystem lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-store-writers-"));
  try {
    const inputs = [amendment(null), amendment("2026-10-08 15:00:00")];
    const outcomes = await Promise.allSettled(
      inputs.map((input) => new ResearchStore(directory, seed).amend(input)),
    );
    const winner = outcomes.findIndex(
      (outcome) => outcome.status === "fulfilled",
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    assert.equal(loser?.status, "rejected");
    assert.match(
      String((loser as PromiseRejectedResult).reason),
      /changed|revision|reload/i,
    );
    const view = await new ResearchStore(directory, seed).open(seed.id);
    assert.equal(view.amendments.length, 1);
    assert.equal(view.revision, 1);
    assert.equal(
      effectiveValue(view, seed.rows[0], "closes_at"),
      inputs[winner].value,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
function writer(directory: string, value: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./helpers/concurrent-writer.ts", import.meta.url)),
      directory,
      value,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let text = "",
    stderr = "";
  let resolveReady: () => void, rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.stdout.on("data", (chunk) => {
    text += String(chunk);
    if (text.includes('{"ready":true}')) resolveReady();
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = new Promise<{ accepted: boolean; error?: string }>(
    (resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Owned test writer timed out"));
        rejectReady(new Error("Writer readiness timed out"));
      }, 10000);
      child.on("error", (error) => {
        clearTimeout(deadline);
        reject(error);
        rejectReady(error);
      });
      child.on("close", (code) => {
        clearTimeout(deadline);
        if (code !== 0) {
          const error = new Error(`Owned test writer failed: ${stderr}`);
          reject(error);
          rejectReady(error);
          return;
        }
        try {
          resolve(JSON.parse(text.trim().split("\n").at(-1)!));
        } catch (error) {
          reject(error);
        }
      });
    },
  );
  return { child, ready, result };
}
test("two child processes produce one accepted correction and one conflict without a lost amendment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-process-writers-"));
  const writers = [writer(directory, "null"), writer(directory, "date")];
  try {
    await Promise.all(writers.map((item) => item.ready));
    writers.forEach((item) => item.child.stdin.end("go\n"));
    const outcomes = await Promise.all(writers.map((item) => item.result));
    assert.equal(outcomes.filter((item) => item.accepted).length, 1);
    assert.match(
      outcomes.find((item) => !item.accepted)!.error!,
      /changed|revision|reload/i,
    );
    const view = await new ResearchStore(directory, seed).open(seed.id);
    assert.equal(view.revision, 1);
    assert.equal(view.amendments.length, 1);
    assert.equal(
      effectiveValue(view, seed.rows[0], "closes_at"),
      outcomes[0].accepted ? null : "2026-10-08 15:00:00",
    );
  } finally {
    writers.forEach((item) => {
      if (item.child.exitCode === null && item.child.signalCode === null)
        item.child.kill("SIGKILL");
    });
    await Promise.allSettled(writers.map((item) => item.result));
    await rm(directory, { recursive: true, force: true });
  }
});
test("a crash writer lock stays owned and returns explicit busy without stale takeover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-crash-lock-"));
  const owner = join(directory, ".writer-lock", "owner-test-token.json");
  const record = JSON.stringify({
    token: "test-token",
    pid: -1,
    createdAt: "2000-01-01T00:00:00Z",
  });
  try {
    await mkdir(join(directory, ".writer-lock"));
    await writeFile(owner, record);
    await assert.rejects(
      new ResearchStore(directory, seed, undefined, 30).amend(amendment(null)),
      /busy.*explicit owner recovery/i,
    );
    assert.equal(await readFile(owner, "utf8"), record);
    assert.equal(
      (await new ResearchStore(directory, seed).open(seed.id)).revision,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
async function processStopped(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}
const STARTUP_ALLOWANCE_MS = 10_000;
// An unusual value, so only the engine's own kill timer is recognised.
const BRIDGE_KILL_TIMER_MS = 600_017;
async function waitForPid(
  file: string,
  allowanceMs: number,
): Promise<number | undefined> {
  const deadline = Date.now() + allowanceMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(file, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(25);
  }
  return undefined;
}
test(
  "bridge timeout stops its owned process group including a sleeping child",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "sourcesql-bridge-group-"));
    const script = join(directory, "bridge.mjs"),
      pidFile = join(directory, "owned-child.pid");
    let childPid: number | undefined;
    try {
      await writeFile(
        script,
        `import {spawn} from "node:child_process";\nimport {writeFileSync} from "node:fs";\nconst child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});\nwriteFileSync(process.argv[2],String(child.pid));\nprocess.stdin.resume();\nsetInterval(()=>{},1000);\n`,
      );
      const engine = new PythonEngine(directory, process.env, {
        command: process.execPath,
        args: [script, pidFile],
        timeoutMs: BRIDGE_KILL_TIMER_MS,
      });
      // The engine arms its kill timer at spawn, so a short timeout races the
      // child's startup. Capture the timer's callback and fire it only after
      // the child's PID is observed: startup gets a generous allowance and the
      // kill still goes through the engine's own timeout path.
      let fireKillTimer: (() => void) | undefined;
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((
        callback: () => void,
        delayMs?: number,
        ...rest: unknown[]
      ) => {
        if (delayMs === BRIDGE_KILL_TIMER_MS) fireKillTimer = callback;
        return realSetTimeout(callback, delayMs, ...rest);
      }) as typeof setTimeout;
      let outcome: Promise<void>;
      try {
        outcome = assert.rejects(
          engine.call("capabilities"),
          /Engine timed out/,
        );
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      childPid = await waitForPid(pidFile, STARTUP_ALLOWANCE_MS);
      assert.ok(
        fireKillTimer,
        "The engine must arm its kill timer when it spawns",
      );
      fireKillTimer();
      if (childPid === undefined) {
        await outcome;
        assert.fail(
          `The test child process did not start within ${STARTUP_ALLOWANCE_MS} ms, so the process-group check could not run. This is a startup failure, not a kill failure. Rerun the test; if it keeps happening, check machine load.`,
        );
      }
      await outcome;
      for (
        let retry = 0;
        retry < 80 && !(await processStopped(childPid));
        retry++
      )
        await delay(25);
      assert.equal(
        await processStopped(childPid),
        true,
        "The owned bridge child must stop with its process group",
      );
    } finally {
      if (childPid && !(await processStopped(childPid))) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
