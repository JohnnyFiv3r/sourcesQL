import { z } from "zod";
import { effectiveValue, type ResearchView, type Row } from "./schema.js";

type Kind =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "integer_string"
  | "decimal_string"
  | "structured";
type Value = string | number | boolean | null;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const datetimePattern =
  /^(\d{4}-\d{2}-\d{2})(?:[ T]| at )(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?)?(?:\s*(Z|UTC|GMT|[ECMP][SD]T|[+-](?:0\d|1\d|2[0-3]):?[0-5]\d))?$/i;
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function kindOf(value: Exclude<Value, null>): Kind {
  if (typeof value === "number" || typeof value === "boolean")
    return typeof value as "number" | "boolean";
  if (datePattern.test(value)) return "date";
  if (datetimePattern.test(value)) return "datetime";
  return "text";
}

export function correctionKind(
  view: ResearchView,
  row: Row,
  field: string,
): Kind {
  // Anchor validation to original data, even after a correction is cleared.
  const column = view.snapshot.columns.find((c) => c.key === field);
  if (column?.logicalType) {
    const type = column.logicalType.toUpperCase();
    if (type.endsWith("[]") || type.startsWith("STRUCT(") || type === "JSON")
      return "structured";
    if (["BIGINT", "HUGEINT", "UBIGINT"].includes(type))
      return "integer_string";
    if (type.startsWith("DECIMAL(")) return "decimal_string";
    if (
      [
        "DOUBLE",
        "FLOAT",
        "REAL",
        "INTEGER",
        "INT",
        "SMALLINT",
        "TINYINT",
      ].includes(type)
    )
      return "number";
    if (type === "BOOLEAN") return "boolean";
    if (type === "DATE") return "date";
    if (type.startsWith("TIMESTAMP")) return "datetime";
    return "text";
  }
  const original = row.values[field];
  if (original !== null) return kindOf(original as Exclude<Value, null>);
  const peers = view.snapshot.rows
    .map((r) => r.values[field])
    .filter((v) => v !== null);
  if (peers.length && peers.every((v) => typeof v === typeof peers[0])) {
    const kinds = peers.map((v) => kindOf(v as Exclude<Value, null>));
    return kinds.every((k) => k === kinds[0])
      ? kinds[0]
      : typeof peers[0] === "string"
        ? "text"
        : kindOf(peers[0] as Exclude<Value, null>);
  }
  const current = effectiveValue(view, row, field);
  return current === null ? "text" : kindOf(current as Exclude<Value, null>);
}

export function correctionError(kind: Kind, value: Value): string {
  // A cleared value remains missing, never a coerced zero or false.
  if (kind === "structured") return "Structured cells are read-only.";
  if (value === null) return "";
  if (kind === "integer_string")
    return typeof value === "string" && /^-?\d+$/.test(value)
      ? ""
      : "Enter a lossless integer string.";
  if (kind === "decimal_string")
    return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)
      ? ""
      : "Enter a lossless decimal string.";
  if (kind === "number")
    return typeof value === "number" && Number.isFinite(value)
      ? ""
      : "Enter a valid number.";
  if (kind === "boolean")
    return typeof value === "boolean" ? "" : "Choose true or false.";
  if (typeof value !== "string") return "Enter text for this field.";
  if (value.length > 8000) return "Use 8,000 characters or fewer.";
  if (kind === "date")
    return z.iso.date().safeParse(value).success
      ? ""
      : "Enter a valid date as YYYY-MM-DD.";
  if (kind === "datetime") {
    const match = value.match(datetimePattern);
    if (
      !match ||
      !z.iso.date().safeParse(match[1]).success ||
      (match[5]
        ? Number(match[2]) < 1 || Number(match[2]) > 12
        : Number(match[2]) > 23) ||
      Number(match[3]) > 59 ||
      Number(match[4] ?? 0) > 59
    )
      return "Enter a valid date and time as YYYY-MM-DD HH:mm:ss.";
  }
  return "";
}

export function parseCorrection(
  kind: Kind,
  draft: string,
): { value: Value; error: string } {
  if (!draft.trim()) return { value: null, error: "" };
  let value: Value = draft;
  if (kind === "number") {
    if (!numberPattern.test(draft.trim()))
      return { value: null, error: "Enter a valid number." };
    value = Number(draft);
  }
  if (kind === "boolean") {
    if (draft !== "true" && draft !== "false")
      return { value: null, error: "Choose true or false." };
    value = draft === "true";
  }
  return { value, error: correctionError(kind, value) };
}
