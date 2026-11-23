import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const appDirectory = fileURLToPath(new URL("..", import.meta.url));

export function runBuild(): number {
  const result = spawnSync("npm", ["run", "build"], {
    stdio: "inherit",
    cwd: appDirectory,
  });
  return result.status ?? 1;
}

/**
 * Several tests read dist/research.html, which only the build creates. Build
 * once when it is missing; an existing dist is used as it is, even if stale.
 * Returns the exit status the preflight should use.
 */
export function ensureBuilt(
  distFile: string = `${appDirectory}dist/research.html`,
  build: () => number = runBuild,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): number {
  if (existsSync(distFile)) return 0;
  log(
    "dist/research.html is missing; running npm run build once before the tests.",
  );
  return build();
}
