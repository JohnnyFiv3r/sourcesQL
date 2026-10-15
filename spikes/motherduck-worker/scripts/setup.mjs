import { readFileSync } from "node:fs";

const database = process.argv[2];
if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(database ?? "")) {
  throw new Error("Usage: npm run setup-sql -- your_probe_database");
}
const code = readFileSync(new URL("../flight.py", import.meta.url), "utf8");
const literal = (s) => `'${s.replaceAll("'", "''")}'`;
// Generates SQL only. Does not create an account, connect, submit, or spend.
console.log(`SELECT * FROM md_create_flight(
  name := 'sourcesql_gateway_probe',
  source_code := ${literal(code)},
  requirements_txt := 'duckdb==1.5.6',
  config := MAP {'REQUEST_ID': 'unsubmitted', 'DATABASE': ${literal(database)}},
  instance_type := 'F4', max_runtime_sec := 120
);`);
