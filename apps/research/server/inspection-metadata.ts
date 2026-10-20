import type { InspectionSqlClient } from "./inspection-records.js";

// Existing immutable metadata remains a JSON blob: DuckDB must still parse it.
// This helper bounds the fields crossing the SQL connection, not parsing work.
// The caller separately authorizes the result and all contributing parents.
const publicFields = [
  "result_id",
  "run_id",
  "content_sha256",
  "data_classification",
  "provenance",
  "created_at",
  "profile_revision",
  "query_sha256",
  "receipt_id",
  "receipt_revision",
  "row_count",
  "parents",
  "lineage_precision",
  "replay_level",
  "bound_evidence_cells",
  "research_requirements",
  "query",
  "parameters",
  "source_bindings",
  "cell_diagnostics",
  "research_quality",
  "query_feedback",
  "citation_feedback",
  "request_id",
  "job_id",
  "status",
  "receipt",
  "latest_receipt",
  "foreign_receipt",
] as const;
const encodedSize = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
// Control requests are private, including when retained inside a receipt. Strip
// that field in the producer before even selecting its public encoded length.
const publicValue = `CASE WHEN entry.key IN ('receipt','latest_receipt','foreign_receipt')
  AND json_type(entry.value)='OBJECT'
  THEN json_merge_patch(entry.value,'{"resume_request":null}')
  ELSE entry.value END`;

/** Return fitting public metadata fields and explicit bounded omission details. */
export async function readInspectionMetadata(
  client: InspectionSqlClient,
  tableName: string,
  resultId: string,
  maxBytes: number,
): Promise<{
  metadata: Record<string, unknown>;
  omissions: { field: string; bytes: number }[];
}> {
  if (
    !/^(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)){0,2}$/.test(
      tableName,
    )
  )
    throw new Error("Invalid inspection table identifier");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4096)
    throw new Error(
      "Inspection metadata allowance must be at least 4096 bytes",
    );
  const descriptor = await client.query(
    `SELECT entry.key AS field,octet_length(encode(CAST(${publicValue} AS VARCHAR))) AS field_bytes
     FROM ${tableName} AS result,json_each(result.metadata) AS entry
     WHERE result.id=$1 AND entry.key IN (
       SELECT json_extract_string(value,'$') FROM json_each(CAST($2 AS JSON))
     )`,
    [resultId, JSON.stringify(publicFields)],
  );
  const descriptors = new Map<string, number>();
  for (const row of descriptor.rows) {
    const field = row.field,
      bytes =
        typeof row.field_bytes === "string"
          ? Number(row.field_bytes)
          : row.field_bytes;
    if (
      typeof field !== "string" ||
      !(publicFields as readonly string[]).includes(field) ||
      !Number.isSafeInteger(bytes) ||
      Number(bytes) < 0 ||
      descriptors.has(field)
    )
      throw new Error("Invalid retained inspection metadata descriptor");
    descriptors.set(field, Number(bytes));
  }
  const candidates = publicFields.flatMap((field) => {
    const bytes = descriptors.get(field);
    return bytes === undefined ? [] : [{ field, bytes }];
  });
  const output: {
    metadata: Record<string, unknown>;
    omissions: { field: string; bytes: number }[];
  } = {
    metadata: {},
    omissions: [],
  };
  // Reserve enough space to report every refusal, rather than allowing a large
  // optional receipt to crowd out provenance or hide why a field is absent.
  const completeBytes =
    encodedSize(output) +
    candidates.reduce(
      (total, candidate) =>
        total + encodedSize(candidate.field) + candidate.bytes + 2,
      0,
    ) -
    (candidates.length ? 1 : 0);
  let available =
    maxBytes - encodedSize({ metadata: {}, omissions: candidates }) - 128;
  const selected: string[] = [];
  for (const candidate of candidates) {
    const bytes = encodedSize(candidate.field) + candidate.bytes + 2;
    if (completeBytes <= maxBytes || bytes <= available) {
      selected.push(candidate.field);
      available -= bytes;
    } else output.omissions.push(candidate);
  }
  if (selected.length) {
    const fields = await client.query(
      `SELECT entry.key AS field,CAST(${publicValue} AS VARCHAR) AS field_json
       FROM ${tableName} AS result,json_each(result.metadata) AS entry
       WHERE result.id=$1 AND entry.key IN (
         SELECT json_extract_string(value,'$') FROM json_each(CAST($2 AS JSON))
       )`,
      [resultId, JSON.stringify(selected)],
    );
    if (fields.rows.length !== selected.length)
      throw new Error("Retained inspection metadata changed while being read");
    const remaining = new Set(selected);
    for (const row of fields.rows) {
      if (
        typeof row.field !== "string" ||
        !remaining.delete(row.field) ||
        typeof row.field_json !== "string"
      )
        throw new Error("Invalid retained inspection metadata field");
      output.metadata[row.field] = JSON.parse(row.field_json);
    }
    // JSON encoders can format numeric scalars differently. Enforce the actual
    // outgoing bound too, removing the lowest-priority selected fields first.
    while (encodedSize(output) > maxBytes && selected.length) {
      const field = selected.pop()!;
      delete output.metadata[field];
      output.omissions.push({ field, bytes: descriptors.get(field)! });
    }
  }
  if (encodedSize(output) > maxBytes)
    throw new Error(
      "Inspection omission metadata exceeds the public byte allowance",
    );
  return output;
}
