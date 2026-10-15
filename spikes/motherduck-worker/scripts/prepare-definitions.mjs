import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = new URL("../../../", import.meta.url);
const probe = new URL("../", import.meta.url);
const dependencySql = execFileSync(fileURLToPath(new URL(".venv/bin/python", root)),
  [fileURLToPath(new URL("dependencies/setup.py", probe)), "sourcesql_probe_20261014"], {encoding:"utf8"});
const quoted = "'((?:[^']|'')*)'";
const source = dependencySql.match(new RegExp(`source_code := ${quoted}`))[1].replaceAll("''", "'");
const requirements = dependencySql.match(new RegExp(`requirements_txt := ${quoted}`))[1].replaceAll("''", "'");
const definitions = {
  tiny: {name:"sourcesql_gateway_probe_20261014", source:readFileSync(new URL("flight.py",probe),"utf8"), requirements:"duckdb==1.5.6"},
  dependencies: {name:"sourcesql_dependency_probe_20261014", source, requirements},
};
mkdirSync(new URL("generated/",probe),{recursive:true});
writeFileSync(new URL("generated/definitions.mjs",probe),`export default ${JSON.stringify(definitions)};\n`);
console.log('Prepared fixed Flight definitions, with no credentials or cloud calls.');
