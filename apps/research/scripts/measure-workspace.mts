/** Run from the repository root: node --import ./apps/research/node_modules/tsx/dist/loader.mjs apps/research/scripts/measure-workspace.mts
 * or from apps/research: node --import tsx scripts/measure-workspace.mts
 * Output is ignored local qualification evidence, never a product capacity SLA. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { arch, cpus, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  measureWorkspaceCase,
  measureWorkspaceBoundaries,
  workspaceLimits,
} from "./workspace-measurement.js";
import { workspaceStorageDecision } from "./workspace-report.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(
  root,
  process.argv[2] ?? "local/qualification/q1-workspace-20261018.json",
);
if (!output.startsWith(resolve(root, "local") + "/"))
  throw new Error("Write measurement evidence only under ignored local/");
const measuredSourcePaths = [
  "apps/research/server/store.ts",
  "apps/research/server/motherduck.ts",
  "apps/research/server/motherduck-schema.ts",
  "apps/research/server/canonical-json.ts",
  "apps/research/src/schema.ts",
  "apps/research/src/typed-values.ts",
  "apps/research/scripts/workspace-measurement.ts",
  "apps/research/scripts/measure-workspace.mts",
  "apps/research/scripts/workspace-report.ts",
  "apps/research/tests/helpers/motherduck-sql-server.py",
];
const sourceFiles = async () =>
  Object.fromEntries(
    await Promise.all(
      measuredSourcePaths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(resolve(root, path)))
          .digest("hex"),
      ]),
    ),
  );
const sourceFilesAtStart = await sourceFiles();
const python =
  process.env.SOURCESQL_TEST_PYTHON ??
  process.env.SOURCESQL_PYTHON ??
  resolve(root, "local/python312/venv/bin/python");
const pythonEnvironment = JSON.parse(
  execFileSync(
    python,
    [
      "-c",
      'import duckdb,json,platform; print(json.dumps({"python":platform.python_version(),"duckdb":duckdb.__version__}))',
    ],
    { encoding: "utf8" },
  ),
);
const cases = [];
for (const snapshots of [1, 8, 32])
  for (const mutations of [0, 25, 100]) {
    const value = await measureWorkspaceCase(snapshots, mutations);
    cases.push(value);
    process.stderr.write(
      `Local workspace: ${snapshots} snapshots, ${mutations} target mutations, ${value.genuineMutations} committed${value.firstRefusal ? ", first allowance refusal recorded" : ""}\n`,
    );
  }
const boundaries = await measureWorkspaceBoundaries();
const report = {
  schemaVersion: 1,
  sourceFilesAtStart,
  sourceFilesAtEnd: await sourceFiles(),
  recordedAt: new Date().toISOString(),
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  workingTree: execFileSync("git", ["status", "--short"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  tier: "local native DuckDB fixtures; actual MotherDuckStateBackend; no remote DB/Flight/provider/host evidence",
  remoteCalls: 0,
  environment: {
    node: process.version,
    platform: platform(),
    osRelease: release(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    pythonExecutable: python,
    samplesPerDimension: 1,
    ...pythonEnvironment,
  },
  limits: workspaceLimits,
  cases,
  boundaries,
  summary: cases.map((value) => ({
    snapshots: value.snapshotCount,
    targetMutations: value.mutationTarget,
    committedMutations: value.genuineMutations,
    currentBytes: value.final.stateBytes,
    historyBytes: value.final.historyBytes,
    firstRefusal: value.firstRefusal?.operation ?? null,
    historyToCurrentRatio: value.final.historyBytes / value.final.stateBytes,
  })),
  measurementNotes: [
    "Each operation measures native SQL calls and full-state history deltas; metric-query SQL is excluded from operation counts.",
    "serializationProbeMs independently times the production canonical serializer on resulting state; it is not isolated timing inside backend.write.",
    "Node process memory is sampled after operations. Python DuckDB child memory and remote network latency are not measured.",
    "Fixture assembly uses supported APIs, then seeds a fresh local native workspace once. Initial assembly commits are excluded from growth counts.",
    "At the first legitimate storage refusal, growth stops. No allowance is raised, and all failed/refused state hashes, history rows and revisions are checked unchanged.",
    "One sample per matrix dimension establishes bounded measurements only, not a scalability or latency guarantee.",
    "Operation samples start at the supported mutation API. Caller input preparation, separate measurement queries and setup are not included in their wall time.",
    "Source digests are recorded before and after the matrix. Differing digests indicate concurrent checkout edits; this is source-fixture evidence, not a frozen artifact or deployed composition.",
  ],
  decision: workspaceStorageDecision(cases),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
process.stdout.write(output + "\n");
