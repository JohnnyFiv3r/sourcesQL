import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  snapshotSchema,
  webUrl,
  type Snapshot,
  type CellValue,
} from "../src/schema.js";

export type EngineResult = {
  query?: string;
  parameters?: Record<string, string | number | boolean | null>;
  result_id: string;
  run_id: string;
  columns: {
    key: string;
    label: string;
    logical_type: string;
    nullable: boolean;
  }[];
  rows: Record<string, CellValue>[];
  row_ids: string[];
  row_count: number;
  content_sha256: string;
  data_classification?: Snapshot["dataClassification"];
  evidence: Record<string, unknown>[];
  source_versions: Record<string, unknown>[];
  receipt: Record<string, unknown>;
  next_offset: number | null;
};
export interface ResearchEngine {
  call<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
}
export type BridgeProcessOptions = {
  timeoutMs?: number;
  command?: string;
  args?: string[];
};
export class PythonEngine implements ResearchEngine {
  constructor(
    private projectRoot = fileURLToPath(new URL("../../../", import.meta.url)),
    private environment: NodeJS.ProcessEnv = process.env,
    private processOptions: BridgeProcessOptions = {},
  ) {
    if (
      processOptions.timeoutMs !== undefined &&
      (!Number.isInteger(processOptions.timeoutMs) ||
        processOptions.timeoutMs < 1)
    )
      throw new Error("Invalid bridge deadline");
  }
  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const child = spawn(
        this.processOptions.command ??
          this.environment.SOURCESQL_PYTHON ??
          join(this.projectRoot, ".venv/bin/python"),
        this.processOptions.args ?? ["-m", "sourcesql.bridge"],
        {
          cwd: this.projectRoot,
          env: this.environment,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      let output = "",
        settled = false;
      const finish = (error: Error | null, result?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(result!);
      };
      const terminateOwnedGroup = () => {
        if (!child.pid) return;
        try {
          if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
        }
        return true;
      };
      const timer = setTimeout(() => {
        const stopped = terminateOwnedGroup();
        finish(
          new Error(
            stopped === false
              ? "Engine timed out; owned process cleanup failed. Inspect the run before retrying."
              : "Engine timed out; inspect the run before retrying.",
          ),
        );
      }, this.processOptions.timeoutMs ?? 30000);
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (Buffer.byteLength(output) > 8 * 1024 * 1024) {
          terminateOwnedGroup();
          finish(
            new Error(
              "Engine response exceeds transport limit; read a smaller page.",
            ),
          );
        }
      });
      // Machine-only stdout. Do not expose local paths/provider diagnostics to clients.
      child.stderr.on("data", () => {});
      child.on("error", () =>
        finish(
          new Error(
            "Local sourcesQL engine unavailable; configure SOURCESQL_PYTHON and the project environment.",
          ),
        ),
      );
      child.on("close", () => {
        try {
          const lines = output.trim().split("\n");
          if (lines.length !== 1) throw new Error();
          const result = JSON.parse(lines[0]);
          if (result.id !== id) throw new Error();
          if (result.error)
            finish(
              new Error(
                `${String(result.error.code)}: ${String(result.error.message)}`,
              ),
            );
          else if (Object.hasOwn(result, "result"))
            finish(null, result.result as T);
          else throw new Error();
        } catch {
          finish(new Error("Invalid engine bridge response."));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ id, method, params }) + "\n");
    });
  }
}
export type ResultReference = {
  result_id: string;
  snapshot_id: string;
  title: string;
};
export function resultSnapshot(
  result: EngineResult,
  reference: ResultReference,
): Snapshot {
  const capturedAt = String(
    result.receipt.finished_at ?? result.receipt.completed_at ?? "",
  );
  const fields = new Set(result.columns.map((column) => column.key));
  const sources = new Map(
    result.source_versions.map((source) => [source.source_version_id, source]),
  );
  const lineage = result.evidence.filter((entry) => !entry.row_id);
  const rows = result.rows.map((values, index) => {
    const rowId = result.row_ids[index];
    const records = result.evidence.filter((e) => e.row_id === rowId);
    const evidence: Record<string, string[]> = {};
    const cellSources: NonNullable<Snapshot["rows"][number]["cellSources"]> =
      {};
    const urls = new Set<string>();
    const seenSupport = new Set<string>();
    for (const entry of records) {
      const field = entry.column_key;
      if (
        typeof field !== "string" ||
        !fields.has(field) ||
        values[field] === null ||
        values[field] === undefined ||
        (entry.status !== undefined &&
          !["supported_text", "processed", "no_match"].includes(
            String(entry.status),
          ))
      )
        continue;
      for (const span of (Array.isArray(entry.support)
        ? entry.support
        : Array.isArray(entry.support_spans)
          ? entry.support_spans
          : []) as Record<string, unknown>[]) {
        if (
          !span ||
          typeof span !== "object" ||
          typeof span.quote !== "string" ||
          !span.quote.trim()
        )
          continue;
        const sourceVersionId =
          span.source_version_id ?? entry.source_version_id;
        const supportIdentity = JSON.stringify([
          field,
          entry.evidence_id ?? entry.id ?? null,
          sourceVersionId ?? null,
          span.quote,
          span.start ?? null,
          span.end ?? null,
          span.field ?? null,
          span.item ?? null,
        ]);
        if (seenSupport.has(supportIdentity)) continue;
        seenSupport.add(supportIdentity);
        (evidence[field] ??= []).push(span.quote);
        // Only canonical source-version references establish citation links.
        // An output URL or an input-set reference cannot prove this cell.
        const url = sources.get(sourceVersionId)?.url;
        if (typeof url === "string" && webUrl.safeParse(url).success) {
          urls.add(url);
          if (!(cellSources[field] ?? []).some((source) => source.url === url))
            (cellSources[field] ??= []).push({ url });
        }
      }
    }
    return {
      id: rowId,
      values,
      sourceUrl: urls.size === 1 ? [...urls][0] : null,
      ...(urls.size
        ? { sources: [...urls].slice(0, 12).map((url) => ({ url })) }
        : {}),
      evidenceRefs: [...records, ...lineage]
        .map((entry) => String(entry.id ?? entry.evidence_id ?? ""))
        .filter((id, index, refs) => !!id && refs.indexOf(id) === index),
      evidence,
      cellSources,
      verificationNote: Object.keys(evidence).length
        ? "Direct textual support; not a truth guarantee."
        : lineage.length
          ? "Input-set lineage; no direct cell attribution."
          : records.length
            ? "Evidence retained; no direct cell attribution."
            : "No directly attributed evidence.",
    };
  });
  return {
    schemaVersion: 2,
    id: reference.snapshot_id,
    title: reference.title,
    origin: {
      engine: "sourcesql",
      resultId: result.result_id,
      runId: result.run_id,
    },
    capturedAt,
    capturePrecision: "instant",
    captureBasis: "run_completed_at",
    parentSnapshotId: null,
    rowCount: result.row_count,
    dataClassification: result.data_classification ?? "synthetic_fixture",
    coverage: {
      planComplete: result.receipt.status === "completed",
      corpusComplete:
        result.receipt.corpus_coverage === "bounded_fixture"
          ? "bounded_fixture"
          : "unknown",
      notes: [
        result.receipt.corpus_coverage === "bounded_fixture"
          ? "Bounded fixture execution; no live provider or host qualification."
          : "Corpus coverage unknown; textual support does not establish completeness or host qualification.",
      ],
    },
    columns: result.columns.map((c) => ({
      key: c.key,
      label: c.label,
      logicalType: c.logical_type,
      nullable: c.nullable,
    })),
    rows,
    dataRef: {
      resultId: result.result_id,
      contentSha256: result.content_sha256,
    },
    previewOffset: 0,
  };
}
export function boundedPreview(snapshot: Snapshot, offset = 0): Snapshot {
  let count = Math.min(100, snapshot.rows.length - offset);
  let preview = {
    ...snapshot,
    rows: snapshot.rows.slice(offset, offset + count),
    ...(snapshot.dataRef ? { previewOffset: offset } : {}),
  };
  while (
    new TextEncoder().encode(JSON.stringify(preview)).byteLength > 195000 &&
    count > 1
  ) {
    count = Math.max(1, Math.floor(count / 2));
    preview = { ...preview, rows: snapshot.rows.slice(offset, offset + count) };
  }
  if (new TextEncoder().encode(JSON.stringify(preview)).byteLength > 200000)
    throw new Error(
      "A research row exceeds the app window allowance; select a narrower SQL projection. Full engine data remains available through read_result/export.",
    );
  return preview;
}
function validatePage(snapshot: Snapshot, offset: number) {
  let position = 0;
  while (position < snapshot.rows.length) {
    const preview = boundedPreview(
      { ...snapshot, rows: snapshot.rows.slice(position) },
      0,
    );
    snapshotSchema.parse({ ...preview, previewOffset: offset + position });
    position += preview.rows.length;
  }
  if (!snapshot.rows.length) snapshotSchema.parse(snapshot);
}
export async function resolveResult(
  engine: ResearchEngine,
  reference: ResultReference,
): Promise<Snapshot> {
  let page = await engine.call<EngineResult>("read_result", {
    result_id: reference.result_id,
    offset: 0,
    limit: 100,
  });
  if (page.result_id !== reference.result_id)
    throw new Error("Engine returned a different result identity");
  const snapshot = resultSnapshot(page, reference);
  validatePage(snapshot, 0);
  const allRows = [...snapshot.rows];
  let offset = page.next_offset;
  while (offset !== null) {
    if (offset < allRows.length || allRows.length > 100000)
      throw new Error("Invalid engine pagination");
    page = await engine.call<EngineResult>("read_result", {
      result_id: reference.result_id,
      offset,
      limit: 100,
    });
    if (
      page.content_sha256 !== snapshot.dataRef!.contentSha256 ||
      page.row_count !== snapshot.rowCount
    )
      throw new Error("Engine result changed while paging");
    const next = resultSnapshot(page, reference);
    validatePage(next, offset);
    allRows.push(...next.rows);
    offset = page.next_offset;
  }
  if (allRows.length !== snapshot.rowCount)
    throw new Error("Engine result row count mismatch");
  return { ...snapshot, rows: allRows };
}
