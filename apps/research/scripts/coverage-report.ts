// Runs the app tests under Node's built-in coverage, then prints per-file line
// and branch figures and the files coverage cannot measure (docs/coverage.md).
// A low figure never fails the run; the exit status is the test run's.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = join(appRoot, "..", "..", "docs", "coverage.md");
const lcovPath = join(appRoot, "coverage", "lcov.info");
const summaryPath = join(appRoot, "coverage", "summary.txt");
const jsonPath = join(appRoot, "coverage", "coverage-summary.json");
const htmlPath = join(appRoot, "coverage", "index.html");
const footer =
  "These files show 0% or are missing in the table above. That means not measured, not untested.";

type Figures = { lines: number; linesHit: number; branches: number; branchesHit: number };

// Node's lcov output has DA/BRF/BRH records and no LF/LH totals, so lines are counted from DA.
function parseLcov(text: string): Map<string, Figures> {
  const files = new Map<string, Figures>();
  let current: Figures | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      current = { lines: 0, linesHit: 0, branches: 0, branchesHit: 0 };
      files.set(line.slice(3), current);
    } else if (current && line.startsWith("DA:")) {
      current.lines += 1;
      if (Number(line.slice(3).split(",")[1]) > 0) current.linesHit += 1;
    } else if (current && line.startsWith("BRF:")) {
      current.branches = Number(line.slice(4));
    } else if (current && line.startsWith("BRH:")) {
      current.branchesHit = Number(line.slice(4));
    }
  }
  return files;
}

const percent = (hit: number, total: number) =>
  total === 0 ? "n/a" : `${Math.round((100 * hit) / total)}%`;

function table(files: Map<string, Figures>): string {
  const total: Figures = { lines: 0, linesHit: 0, branches: 0, branchesHit: 0 };
  const rows = ["sourcesQL app coverage (lines, branches)", `${"Module".padEnd(58)}${"Lines".padStart(7)}${"Branches".padStart(10)}`];
  for (const [path, figures] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    rows.push(
      `${path.padEnd(58)}${percent(figures.linesHit, figures.lines).padStart(7)}${percent(figures.branchesHit, figures.branches).padStart(10)}`,
    );
    for (const key of Object.keys(total) as (keyof Figures)[]) total[key] += figures[key];
  }
  rows.push(
    `${"TOTAL".padEnd(58)}${percent(total.linesHit, total.lines).padStart(7)}${percent(total.branchesHit, total.branches).padStart(10)}`,
  );
  return rows.join("\n");
}

const pct = (hit: number, total: number) =>
  total === 0 ? null : Math.round((1000 * hit) / total) / 10;

function totals(files: Map<string, Figures>): Figures {
  const total: Figures = { lines: 0, linesHit: 0, branches: 0, branchesHit: 0 };
  for (const figures of files.values())
    for (const key of Object.keys(total) as (keyof Figures)[]) total[key] += figures[key];
  return total;
}

// Machine-readable figures (one decimal) for consumers of the CI artifact.
function summaryJson(files: Map<string, Figures>): string {
  const entry = (figures: Figures) => ({
    lines: { total: figures.lines, covered: figures.linesHit, pct: pct(figures.linesHit, figures.lines) },
    branches: { total: figures.branches, covered: figures.branchesHit, pct: pct(figures.branchesHit, figures.branches) },
  });
  return JSON.stringify(
    {
      total: entry(totals(files)),
      files: Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, figures]) => [path, entry(figures)])),
    },
    null,
    2,
  );
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Plain text in a <pre>: the same report the terminal shows, openable from the artifact.
const summaryHtml = (report: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><title>sourcesQL app coverage</title><body><pre>${escapeHtml(report)}</pre></body></html>\n`;

function notMeasured(): string[] {
  const block = /```not-measured\n([\s\S]*?)```/.exec(readFileSync(doc, "utf8"));
  if (!block) throw new Error(`${doc} has no not-measured block.`);
  return block[1]
    .split("\n")
    .filter((line) => line.startsWith("apps/research/") && line.includes(" | "))
    .map((line) => {
      const [path, checkedBy] = line.split(" | ");
      return `  ${path}  checked by: ${checkedBy}`;
    });
}

mkdirSync(join(appRoot, "coverage"), { recursive: true });
// A launch that never reaches the test runner must not leave an earlier run's figures looking current.
for (const stale of [lcovPath, summaryPath, jsonPath, htmlPath]) rmSync(stale, { force: true });
const run = spawnSync(
  process.execPath,
  [
    "--import", "tsx",
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=server/**",
    "--test-coverage-include=src/**",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=lcov", `--test-reporter-destination=${lcovPath}`,
    ...process.argv.slice(2),
    ...(process.argv.length > 2 ? [] : ["tests/*.test.ts"]),
  ],
  { cwd: appRoot, stdio: "inherit" },
);

if (!existsSync(lcovPath)) {
  console.error("The test run produced no coverage data, so no coverage report was written.");
  process.exit(run.status || 1);
}
const files = parseLcov(readFileSync(lcovPath, "utf8"));
const report = [
  table(files),
  "",
  "Not measured (runs in Python child processes or is never loaded by a test):",
  ...notMeasured(),
  footer,
].join("\n");
writeFileSync(summaryPath, `${report}\n`);
writeFileSync(jsonPath, `${summaryJson(files)}\n`);
writeFileSync(htmlPath, summaryHtml(report));
console.log(`\n${report}`);
process.exit(run.status ?? 1);
