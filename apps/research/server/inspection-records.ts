/**
 * Bounded projections over retained DuckDB JSON blobs. The database still parses
 * those blobs; this is not indexed record storage. Callers must fully authorize
 * the immutable result and its dependencies before using these read helpers.
 */
export interface InspectionSqlClient {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export type InspectionCollection =
  "rows" | "evidence" | "source_versions" | "cell_diagnostics";
export type InspectionRecordPage = {
  offset: number;
  returned: number;
  total: number;
  next_offset: number | null;
  oversized_record_index?: number;
  complete?: false;
  chunk_required?: {
    tool: "sourcesql_inspect_evidence";
    collection: InspectionCollection;
    record_index: number;
    chunk_offset: 0;
    next_offset_after_chunk: number | null;
  };
};
export type InspectionRecordsOptions = {
  collection: InspectionCollection;
  offset: number;
  limit: number;
  rowIds?: string[];
  columns?: string[];
  maxBytes: number;
};
export type InspectionChunkOptions = {
  collection: InspectionCollection;
  record_index: number;
  chunk_offset?: number;
  chunk_limit?: number;
  maxBytes: number;
};
type RecordValue = Record<string, unknown>;
const size = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
const collections = new Set<InspectionCollection>([
  "rows",
  "evidence",
  "source_versions",
  "cell_diagnostics",
]);
function integer(
  value: unknown,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (
    !Number.isSafeInteger(parsed) ||
    Number(parsed) < 0 ||
    Number(parsed) > maximum
  )
    throw new Error(`Invalid inspection ${name}`);
  return Number(parsed);
}
function configuration(
  tableName: string,
  collection: InspectionCollection,
  maxBytes: number,
) {
  // Only trusted identifiers enter SQL syntax. Every caller-controlled value,
  // including indexes, scope IDs and JSON paths, uses a bound parameter.
  if (
    !/^(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[A-Za-z_][A-Za-z0-9_]*"|[A-Za-z_][A-Za-z0-9_]*)){0,2}$/.test(
      tableName,
    )
  )
    throw new Error("Invalid inspection table identifier");
  if (!collections.has(collection))
    throw new Error("Invalid inspection collection");
  if (integer(maxBytes, "byte allowance") < 4096)
    throw new Error("Inspection allowance must be at least 4096 bytes");
  return {
    column: collection === "rows" ? "wire_payload" : "metadata",
    path: `$.${collection}`,
  };
}
function page(
  offset: number,
  returned: number,
  total: number,
): InspectionRecordPage {
  return {
    offset,
    returned,
    total,
    next_offset: offset + returned < total ? offset + returned : null,
  };
}
function chunkRequired(
  page: InspectionRecordPage,
  collection: InspectionCollection,
  recordIndex: number,
) {
  page.oversized_record_index = recordIndex;
  page.complete = false;
  page.next_offset = null;
  page.chunk_required = {
    tool: "sourcesql_inspect_evidence",
    collection,
    record_index: recordIndex,
    chunk_offset: 0,
    next_offset_after_chunk:
      page.offset + 1 < page.total ? page.offset + 1 : null,
  };
}
function rowScope(
  collection: InspectionCollection,
  rowIds: string[] | undefined,
) {
  if (
    rowIds !== undefined &&
    (!Array.isArray(rowIds) || rowIds.some((id) => typeof id !== "string"))
  )
    throw new Error("Invalid inspection row scope");
  if (collection !== "evidence" && collection !== "cell_diagnostics")
    return { sql: "", values: [] };
  if (rowIds === undefined && collection === "evidence")
    return { sql: "", values: [] };
  const match =
    "json_extract_string(entry.value, '$.row_id') IN (SELECT json_extract_string(value, '$') FROM json_each(CAST($5 AS JSON)))";
  return {
    sql:
      collection === "evidence"
        ? ` AND (json_extract_string(entry.value, '$.row_id') IS NULL OR ${match})`
        : ` AND ${match}`,
    values: [JSON.stringify(rowIds ?? [])],
  };
}

/** Select indexes/lengths first; transfer only the complete records that fit. */
export async function readInspectionRecords(
  client: InspectionSqlClient,
  tableName: string,
  resultId: string,
  options: InspectionRecordsOptions,
): Promise<{
  values: RecordValue[];
  indexes: number[];
  page: InspectionRecordPage;
}> {
  const { column, path } = configuration(
    tableName,
    options.collection,
    options.maxBytes,
  );
  const offset = integer(options.offset, "record offset"),
    limit = integer(options.limit, "record limit", 1000);
  const scope = rowScope(options.collection, options.rowIds);
  const projected = options.columns !== undefined;
  if (
    projected &&
    (options.collection !== "rows" ||
      !Array.isArray(options.columns) ||
      !options.columns.length ||
      options.columns.length > 128 ||
      new Set(options.columns).size !== options.columns.length ||
      options.columns.some(
        (column) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(column),
      ))
  )
    throw new Error("Invalid inspection column projection");
  const recordValue = (parameter: number) =>
    projected
      ? `(SELECT json_group_object(field.key,field.value) FROM json_each(entry.value) AS field WHERE field.key IN (SELECT json_extract_string(value,'$') FROM json_each(CAST($${parameter} AS JSON))))`
      : "entry.value";
  const columnValues = projected ? [JSON.stringify(options.columns)] : [];

  // Descriptor arrays are bounded too, even when callers request a long page
  // under a small allowance. A shorter intact page retains ordinary progress.
  const descriptorLimit = Math.min(
    limit,
    Math.max(1, Math.floor((options.maxBytes - 512) / 128)),
  );
  const descriptor = await client.query(
    `WITH records AS (
      SELECT CAST(entry.key AS BIGINT) AS record_index, CAST(${recordValue(5)} AS VARCHAR) AS record_json
      FROM ${tableName} AS result, json_each(json_extract(result.${column}, $2)) AS entry
      WHERE result.id=$1${scope.sql}
    ), selected AS (
      SELECT record_index,octet_length(encode(record_json)) AS record_bytes
      FROM records ORDER BY record_index LIMIT $3 OFFSET $4
    )
    SELECT total.total,selected.record_index,selected.record_bytes
    FROM (SELECT count(*) AS total FROM records) AS total
    LEFT JOIN selected ON TRUE ORDER BY selected.record_index`,
    [resultId, path, descriptorLimit, offset, ...scope.values, ...columnValues],
  );
  if (!descriptor.rows.length)
    throw new Error("Inspection descriptor was unavailable");
  const total = integer(descriptor.rows[0].total, "record count");
  const candidates = descriptor.rows.flatMap((row) =>
    row.record_index == null
      ? []
      : [
          {
            index: integer(row.record_index, "record index"),
            bytes: integer(row.record_bytes, "record length"),
          },
        ],
  );
  const output: {
    values: RecordValue[];
    indexes: number[];
    page: InspectionRecordPage;
  } = {
    values: [],
    indexes: [],
    page: page(offset, 0, total),
  };
  // Reserve the largest pagination change before selecting bodies. The final
  // JSON size is checked again because parsing/re-encoding numbers may differ.
  let available = options.maxBytes - size(output) - 512;
  const selected: number[] = [];
  for (const candidate of candidates) {
    const bytes = candidate.bytes + String(candidate.index).length + 3;
    if (bytes > available) break;
    selected.push(candidate.index);
    available -= bytes;
  }
  if (selected.length) {
    const records = await client.query(
      `SELECT CAST(entry.key AS BIGINT) AS record_index,CAST(${recordValue(4)} AS VARCHAR) AS record_json
       FROM ${tableName} AS result, json_each(json_extract(result.${column}, $2)) AS entry
       WHERE result.id=$1 AND CAST(entry.key AS BIGINT) IN (
         SELECT CAST(value AS BIGINT) FROM json_each(CAST($3 AS JSON))
       ) ORDER BY record_index`,
      [resultId, path, JSON.stringify(selected), ...columnValues],
    );
    if (records.rows.length !== selected.length)
      throw new Error("Retained inspection records changed while being read");
    for (let index = 0; index < records.rows.length; index++) {
      const record = records.rows[index];
      if (
        integer(record.record_index, "record index") !== selected[index] ||
        typeof record.record_json !== "string"
      )
        throw new Error("Retained inspection record identity was invalid");
      output.values.push(JSON.parse(record.record_json) as RecordValue);
      output.indexes.push(selected[index]);
    }
    output.page = page(offset, output.values.length, total);
    while (output.values.length && size(output) > options.maxBytes) {
      output.values.pop();
      output.indexes.pop();
      output.page = page(offset, output.values.length, total);
    }
  }
  if (!output.values.length && candidates.length)
    chunkRequired(output.page, options.collection, candidates[0].index);
  if (size(output) > options.maxBytes)
    throw new Error("Inspection pagination exceeds the public byte allowance");
  return output;
}

/** Read a JSON substring at the producer, never a complete oversized body. */
export async function readInspectionChunk(
  client: InspectionSqlClient,
  tableName: string,
  resultId: string,
  options: InspectionChunkOptions,
) {
  const { column, path } = configuration(
    tableName,
    options.collection,
    options.maxBytes,
  );
  const index = integer(options.record_index, "record index"),
    start = integer(options.chunk_offset ?? 0, "chunk offset"),
    limit = integer(options.chunk_limit ?? 32768, "chunk limit", 131072);
  if (!limit) throw new Error("Invalid inspection chunk limit");
  const recordPath = `${path}[${index}]`;
  const descriptor = await client.query(
    `SELECT length(CAST(json_extract(${column},$2) AS VARCHAR)) AS record_characters${options.collection === "rows" ? ",json_extract_string(metadata,$3) AS row_id" : ""}
     FROM ${tableName} WHERE id=$1`,
    [
      resultId,
      recordPath,
      ...(options.collection === "rows" ? [`$.row_ids[${index}]`] : []),
    ],
  );
  const record = descriptor.rows[0];
  if (!record || record.record_characters == null)
    throw new Error("Requested retained record is unavailable");
  const total = integer(record.record_characters, "record characters");
  if (start > total) throw new Error("Invalid inspection JSON chunk boundary");
  const header = {
    result_id: resultId,
    collection: options.collection,
    record_index: index,
    ...(options.collection === "rows" ? { row_id: record.row_id } : {}),
    encoding: "json" as const,
    offset_unit: "unicode_code_points" as const,
    chunk_offset: start,
    next_chunk_offset: null as number | null,
    total_characters: total,
    json_chunk: "",
  };
  // A Unicode code point occupies at most four UTF-8 bytes; JSON escaping can
  // require six ASCII bytes. Bound the SQL projection before transferring it.
  const safeLimit = Math.floor((options.maxBytes - size(header) - 64) / 6);
  if (safeLimit < 1)
    throw new Error("Inspection allowance cannot hold a JSON chunk");
  const length = Math.min(limit, safeLimit, total - start);
  const response = await client.query(
    `SELECT substr(CAST(json_extract(${column},$2) AS VARCHAR),$3,$4) AS json_chunk FROM ${tableName} WHERE id=$1`,
    [resultId, recordPath, start + 1, length],
  );
  const chunk = response.rows[0]?.json_chunk;
  if (typeof chunk !== "string")
    throw new Error("Requested retained record is unavailable");
  const returned = Array.from(chunk).length;
  if (returned !== length)
    throw new Error("Retained inspection chunk length was invalid");
  const output = {
    ...header,
    next_chunk_offset: start + returned < total ? start + returned : null,
    json_chunk: chunk,
  };
  if (size(output) > options.maxBytes)
    throw new Error("Inspection chunk exceeds the public byte allowance");
  return output;
}
