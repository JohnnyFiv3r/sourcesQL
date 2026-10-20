/** Structural admission shared by MCP and hosted query reservation. */
import { Buffer } from "node:buffer";
import { z } from "zod";

const MAX_CITATIONS = 2048;
const MAX_CITATION_BYTES = 2 * 1024 * 1024;
const forbiddenKeys = new Set(["constructor", "prototype", "__proto__"]);
const key = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}(?![\s\S])/)
  .refine((value) => !forbiddenKeys.has(value));

function boundedUnicode(value: string, maximum: number): boolean {
  let characters = 0;
  for (let index = 0; index < value.length; index++, characters++) {
    if (characters >= maximum) return false;
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
const unicodeString = (maximum: number) =>
  z.string().refine((value) => boundedUnicode(value, maximum), {
    message: `Expected well-formed Unicode of at most ${maximum} code points`,
  });

// Python str.strip() includes C0 separators and U+0085, but not U+FEFF.
// Keep quote admission identical without trimming or normalizing source text.
const hasNonWhitespace =
  /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
const offset = z
  .number()
  .finite()
  .nonnegative()
  .refine(
    (value) => Number.isInteger(value) && value < 1e21,
    "Offsets must serialize as nonnegative JSON integers",
  );
const citation = z
  .object({
    match: z
      .record(
        key,
        z.union([
          unicodeString(8000),
          z.number().finite(),
          z.boolean(),
          z.null(),
        ]),
      )
      .refine(
        (value) =>
          Object.keys(value).length >= 1 && Object.keys(value).length <= 8,
        "A citation requires one to eight exact row-selector fields",
      ),
    column_key: key,
    source_version_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}(?![\s\S])/),
    quote: unicodeString(12000).refine(
      (value) => hasNonWhitespace.test(value),
      "A citation quote must contain non-whitespace text",
    ),
    start: offset.optional(),
    end: offset.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.start === undefined
        ? value.end === undefined
        : value.end !== undefined && value.start < value.end,
    "Citation start and end must be supplied together with start < end",
  );

type Citation = z.infer<typeof citation>;
function canonicalNumber(value: number): string {
  // Python normalizes whole DOUBLE selector values to their exact integer.
  // JSON.stringify would undercount e.g. 1e308 by roughly 300 bytes per entry.
  if (Number.isInteger(value)) return BigInt(value).toString();
  if (Math.abs(value) < 1e-4) {
    return value
      .toExponential()
      .replace(/e(-?)(\d)$/, (_, sign, digit) => `e${sign}0${digit}`);
  }
  return value.toString();
}
function canonicalCitation(value: Citation): string {
  const selector = Object.keys(value.match)
    .sort()
    .map((name) => {
      const scalar = value.match[name];
      return `${JSON.stringify(name)}:${typeof scalar === "number" ? canonicalNumber(scalar) : JSON.stringify(scalar)}`;
    });
  const fields: Record<string, string> = {
    match: `{${selector.join(",")}}`,
    column_key: JSON.stringify(value.column_key),
    source_version_id: JSON.stringify(value.source_version_id),
    quote: JSON.stringify(value.quote),
  };
  if (value.start !== undefined && value.end !== undefined) {
    fields.start = value.start.toString();
    fields.end = value.end.toString();
  }
  return `{${Object.keys(fields)
    .sort()
    .map((name) => `${JSON.stringify(name)}:${fields[name]}`)
    .join(",")}}`;
}

export const curatedCitationsSchema = z
  .array(citation)
  .max(MAX_CITATIONS)
  .superRefine((values, context) => {
    if (values.length > MAX_CITATIONS) return;
    // Match validate_citations' pre-deduplication normalized-byte accounting.
    // The extra byte per entry includes its separator, including the last one.
    let size = 2;
    for (const value of values) {
      size += Buffer.byteLength(canonicalCitation(value), "utf8") + 1;
      if (size > MAX_CITATION_BYTES) {
        context.addIssue({
          code: "custom",
          message: "Curated citations exceed the 2 MiB normalized recipe limit",
        });
        return;
      }
    }
  });
