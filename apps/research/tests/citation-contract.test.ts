import { WORKER_FEATURE_CONTRACTS } from "../server/feature-contracts.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { z } from "zod";
import { curatedCitationsSchema } from "../server/citation-contract.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const python =
  process.env.SOURCESQL_TEST_PYTHON ??
  process.env.SOURCESQL_PYTHON ??
  join(root, "local/python312/venv/bin/python");
const base = {
  match: { product: "Aurora" },
  column_key: "claim",
  source_version_id: "src_retained",
  quote: "An exact inspected quotation.",
};
function parity(values: unknown[]) {
  const result = spawnSync(
    python,
    [
      "-B",
      "-c",
      `
import json, sys
from sourcesql.contracts import SourcesQLError
from sourcesql.curation import validate_citations
output = []
for recipe in json.load(sys.stdin):
    try:
        validate_citations(recipe)
        output.append(True)
    except SourcesQLError:
        output.append(False)
print(json.dumps(output))
`,
    ],
    {
      input: JSON.stringify(values),
      cwd: root,
      env: { ...process.env, PYTHONPATH: join(root, "src") },
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const expected = JSON.parse(result.stdout) as boolean[];
  assert.deepEqual(
    values.map((value) => curatedCitationsSchema.safeParse(value).success),
    expected,
  );
  return expected;
}

test("scalar citation admission agrees with Python for Unicode, wire numbers and offsets", () => {
  const valid = [
    [],
    [base],
    [{ ...base, match: { product: "🦆".repeat(8000) } }],
    [{ ...base, quote: "🦆".repeat(12000) }],
    [{ ...base, match: { value: "9007199254740993" } }],
    ...[
      0,
      -0,
      false,
      true,
      null,
      3.25,
      2 ** 53,
      -(2 ** 53),
      1e20,
      1e30,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      -1e-7,
      1.23456e-5,
    ].map((value) => [{ ...base, match: { value } }]),
    [{ ...base, start: 0, end: 2 }],
    [{ ...base, start: 2 ** 53, end: 2 ** 53 + 2 }],
    [{ ...base, start: 1e20, end: 1e20 + 16384 }],
    [{ ...base, quote: "\uFEFF" }],
    [
      {
        ...base,
        match: Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`v${i}`, i]),
        ),
      },
    ],
  ];
  assert.ok(parity(valid).every(Boolean));
  const parsed = curatedCitationsSchema.parse([
    { ...base, match: { count: "9007199254740993", double: 2 ** 53 } },
  ]);
  assert.equal(parsed[0].match.count, "9007199254740993");
  assert.equal(parsed[0].match.double, 2 ** 53);
});

test("structurally invalid recipes agree with Python admission refusals", () => {
  const invalid = [
    [{ ...base, match: { product: "a".repeat(8001) } }],
    [{ ...base, match: { product: "🦆".repeat(8001) } }],
    [{ ...base, quote: "a".repeat(12001) }],
    [{ ...base, quote: "\uD800" }],
    [{ ...base, quote: "a\uDC00" }],
    [{ ...base, match: { product: "\uD800" } }],
    [{ ...base, match: { product: "a\uDC00" } }],
    ...[
      "",
      " ",
      "\t\n\r",
      "\u0085",
      "\u001c\u001d\u001e\u001f",
      "\u2000\u3000",
    ].map((quote) => [{ ...base, quote }]),
    [{ ...base, start: 0 }],
    [{ ...base, end: 1 }],
    [{ ...base, start: 0, end: 0 }],
    [{ ...base, start: 2, end: 1 }],
    [{ ...base, start: -1, end: 1 }],
    [{ ...base, start: false, end: 1 }],
    [{ ...base, start: 0.5, end: 1 }],
    [{ ...base, start: 1e21, end: 1e22 }],
    [{ ...base, match: {} }],
    [
      {
        ...base,
        match: Object.fromEntries(
          Array.from({ length: 9 }, (_, i) => [`v${i}`, i]),
        ),
      },
    ],
    [{ ...base, match: { constructor: "Aurora" } }],
    [{ ...base, match: { "product\n": "Aurora" } }],
    [{ ...base, source_version_id: "src_retained\n" }],
    [{ ...base, source_version_id: "x".repeat(81) }],
    [{ ...base, column_key: "claim\n" }],
    [{ ...base, url: "https://untrusted.example/" }],
    Array.from({ length: 2049 }, () => base),
  ];
  assert.ok(parity(invalid).every((accepted) => !accepted));
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(
      curatedCitationsSchema.safeParse([{ ...base, match: { value } }]).success,
      false,
    );
  }
});

function byteBoundaryRecipe() {
  const values = Array.from({ length: 200 }, () => ({
    ...base,
    quote: "x".repeat(10000),
  }));
  let remaining =
    2 * 1024 * 1024 -
    (2 +
      values.reduce(
        (size, entry) => size + Buffer.byteLength(JSON.stringify(entry)) + 1,
        0,
      ));
  assert.ok(remaining > 0);
  for (const entry of values) {
    const extra = Math.min(12000 - entry.quote.length, remaining);
    entry.quote += "x".repeat(extra);
    remaining -= extra;
  }
  assert.equal(remaining, 0);
  const growable = values.find((entry) => entry.quote.length < 12000)!;
  const over = values.map((entry) =>
    entry === growable ? { ...entry, quote: entry.quote + "x" } : entry,
  );
  return { exact: values, over };
}

test("normalized 2 MiB byte accounting matches Python, including duplicates and whole DOUBLEs", () => {
  const { exact, over } = byteBoundaryRecipe();
  const withLargeDouble = exact.map((entry) => ({
    ...entry,
    match: { product: 1e308 },
  }));
  // Exponent notation would appear smaller than the original selector in JS,
  // while Python's normalized exact integer makes this recipe exceed the cap.
  assert.ok(
    Buffer.byteLength(JSON.stringify(withLargeDouble)) < 2 * 1024 * 1024,
  );
  assert.deepEqual(parity([exact, over, withLargeDouble]), [
    true,
    false,
    false,
  ]);
});

test("a bounded quote that does not occur in its source remains structurally valid feedback", () => {
  const recipe = [
    { ...base, quote: "A semantic quote typo", start: 100, end: 101 },
  ];
  assert.deepEqual(parity([recipe]), [true]);
  assert.deepEqual(curatedCitationsSchema.parse(recipe), recipe);
  // Structural refinements remain usable by MCP's JSON Schema conversion.
  assert.equal(z.toJSONSchema(curatedCitationsSchema).type, "array");
});

test("gateway and Python advertise exactly the same versioned feature contracts", () => {
  const response = spawnSync(
    python,
    [
      "-B",
      "-c",
      "import json; from sourcesql.feature_contracts import WORKER_FEATURE_CONTRACTS; print(json.dumps(WORKER_FEATURE_CONTRACTS))",
    ],
    {
      cwd: root,
      env: { ...process.env, PYTHONPATH: join(root, "src") },
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(response.status, 0, response.stderr);
  assert.deepEqual(JSON.parse(response.stdout), WORKER_FEATURE_CONTRACTS);
});
