import { z } from "zod";
import type { CellValue } from "./schema.js";

function parts(input: string): string[] {
  let depth = 0,
    start = 0;
  const out: string[] = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "(") depth++;
    if (input[i] === ")") depth--;
    if (input[i] === "," && depth === 0) {
      out.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(input.slice(start).trim());
  return out;
}
export function validInstant(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) && z.iso.datetime({ offset: true }).safeParse(value).success
  );
}

export function validateTypedCell(
  type: string,
  value: CellValue | undefined,
  nullable: boolean,
  depth = 0,
): string {
  if (depth > 8) return "Structured cell exceeds maximum depth";
  if (value === undefined) return "Missing declared field";
  if (value === null) return nullable ? "" : "Column does not allow null";
  const t = type.trim().toUpperCase();
  if (t.endsWith("[]"))
    return Array.isArray(value) && value.length <= 1000
      ? (value
          .map((v) => validateTypedCell(type.slice(0, -2), v, true, depth + 1))
          .find(Boolean) ?? "")
      : "Expected bounded list";
  if (t.startsWith("STRUCT(") && t.endsWith(")")) {
    if (typeof value !== "object" || Array.isArray(value))
      return "Expected struct";
    const fields = parts(type.slice(7, -1)).map((f) => {
      const m = f.match(/^([A-Za-z][A-Za-z0-9_]*)\s+(.+)$/);
      return m ? { key: m[1], type: m[2] } : null;
    });
    if (
      fields.some((f) => !f) ||
      fields.length > 128 ||
      Object.keys(value).length !== fields.length
    )
      return "Invalid struct keys or type";
    return (
      fields
        .map((f) => validateTypedCell(f!.type, value[f!.key], true, depth + 1))
        .find(Boolean) ?? ""
    );
  }
  if (["BIGINT", "HUGEINT", "UBIGINT"].includes(t)) {
    if (typeof value !== "string" || !/^-?\d+$/.test(value))
      return "Expected lossless integer string";
    const n = BigInt(value),
      bits = t === "HUGEINT" ? 128n : 64n,
      unsigned = t === "UBIGINT";
    return n >= (unsigned ? 0n : -(1n << (bits - 1n))) &&
      n < 1n << (unsigned ? bits : bits - 1n)
      ? ""
      : "Integer exceeds declared range";
  }
  if (/^DECIMAL\(\d+,\s*\d+\)$/.test(t)) {
    const [precision, scale] = t.slice(8, -1).split(",").map(Number);
    const m = typeof value === "string" && value.match(/^-?(\d+)(?:\.(\d+))?$/);
    return m &&
      m[1].replace(/^0+/, "").length <= precision - scale &&
      (m[2]?.length ?? 0) <= scale
      ? ""
      : "Expected lossless decimal string within declared precision";
  }
  if (
    [
      "INTEGER",
      "INT",
      "SMALLINT",
      "TINYINT",
      "UINTEGER",
      "USMALLINT",
      "UTINYINT",
    ].includes(t)
  ) {
    const bits = t.includes("TINY") ? 8 : t.includes("SMALL") ? 16 : 32,
      unsigned = t.startsWith("U");
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= (unsigned ? 0 : -(2 ** (bits - 1))) &&
      value < 2 ** (unsigned ? bits : bits - 1)
      ? ""
      : "Expected integer within declared range";
  }
  if (["DOUBLE", "FLOAT", "REAL"].includes(t))
    return typeof value === "number" && Number.isFinite(value)
      ? ""
      : "Expected finite number";
  if (t === "BOOLEAN")
    return typeof value === "boolean" ? "" : "Expected Boolean";
  if (t === "DATE")
    return typeof value === "string" && z.iso.date().safeParse(value).success
      ? ""
      : "Expected ISO date";
  if (["TIMESTAMPTZ", "TIMESTAMP WITH TIME ZONE"].includes(t))
    return typeof value === "string" && validInstant(value)
      ? ""
      : "Expected offset-bearing timestamp";
  if (t === "TIMESTAMP")
    return typeof value === "string" &&
      z.iso.datetime({ local: true }).safeParse(value).success
      ? ""
      : "Expected ISO timestamp";
  if (["VARCHAR", "TEXT", "STRING", "UUID"].includes(t))
    return typeof value === "string" && value.length <= 8000
      ? ""
      : "Expected bounded text";
  if (t === "JSON")
    return JSON.stringify(value).length <= 16000
      ? ""
      : "JSON cell exceeds bound";
  return "Unknown logical type: " + type;
}
