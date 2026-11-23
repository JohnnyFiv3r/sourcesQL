import { ensureBuilt } from "./ensure-built.js";
import { resolveTestPython } from "./python.js";

// Runs before the test files so a missing prerequisite is one message, not
// a stack trace per test.
const resolved = resolveTestPython();
if ("message" in resolved) {
  process.stderr.write(`${resolved.message}\n`);
  process.exit(1);
}
process.exit(ensureBuilt());
