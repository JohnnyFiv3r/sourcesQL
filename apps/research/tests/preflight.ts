import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveTestPython } from "./python.js";

// Runs before the test files so a missing prerequisite is one message, not
// a stack trace per test.
const resolved = resolveTestPython();
if ("message" in resolved) {
  process.stderr.write(`${resolved.message}\n`);
  process.exit(1);
}
const built = fileURLToPath(new URL("../dist/research.html", import.meta.url));
if (!existsSync(built)) {
  process.stderr.write(
    "sourcesQL app tests need the built app, and dist/research.html was not found.\n" +
      "Fix: in apps/research run `npm run build`, then `npm test` again, or run `npm run check`, which does both.\n",
  );
  process.exit(1);
}
