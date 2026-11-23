import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export type PythonResolution = { python: string } | { message: string };

function problem(path: string): "missing" | "not executable" | undefined {
  try {
    accessSync(path, constants.X_OK);
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "not executable";
  }
}

/**
 * Finds the interpreter the way the app does: SOURCESQL_TEST_PYTHON, then
 * SOURCESQL_PYTHON, then the .venv that `uv sync` creates. The first variable
 * that is set decides, so a typo fails loudly instead of using another Python.
 * An empty string counts as not set.
 */
export function resolveTestPython(
  env: NodeJS.ProcessEnv = process.env,
  root: string = repoRoot,
): PythonResolution {
  const venv = join(root, ".venv/bin/python");
  const sources = [
    { label: "SOURCESQL_TEST_PYTHON", path: env.SOURCESQL_TEST_PYTHON },
    { label: "SOURCESQL_PYTHON", path: env.SOURCESQL_PYTHON },
    { label: venv, path: venv },
  ];
  const decided = sources.findIndex((source) => source.path);
  const chosen = sources[decided];
  const state = problem(chosen.path!);
  if (!state) return { python: chosen.path! };
  const lines = sources.map((source, index) => {
    const detail =
      index < decided
        ? "(not set)"
        : index > decided
          ? "(not checked)"
          : source.label === source.path
            ? `(${state})`
            : `${source.path}  (${state})`;
    return `  ${source.label}${" ".repeat(Math.max(2, 24 - source.label.length))}${detail}`;
  });
  return {
    message: [
      "sourcesQL app tests need a Python environment, and none was found.",
      "Looked for:",
      ...lines,
      "Fix: from the repository root run `uv sync --frozen`, then run `npm test` again.",
      "Or set SOURCESQL_PYTHON to the path of a Python 3.12+ interpreter that has sourcesQL installed.",
    ].join("\n"),
  };
}

export function testPython(): string {
  const resolved = resolveTestPython();
  if ("message" in resolved) throw new Error(resolved.message);
  return resolved.python;
}
