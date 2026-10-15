import { canonicalJson } from "./canonical-json.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  effectiveValue,
  id,
  key,
  originForSnapshot,
  snapshotSchema,
  sourcesForViewSelection,
  type Amendment,
  type CellValue,
  type ResearchView,
  type Row,
  type Snapshot,
} from "../src/schema.js";
import { validInstant } from "../src/typed-values.js";

const instant = z
  .string()
  .refine(validInstant, "Use an offset-bearing timestamp");
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const rows = z
  .array(id)
  .min(1)
  .max(100)
  .refine(unique, "Row IDs must be unique");
const fields = z
  .array(key)
  .min(1)
  .max(128)
  .refine(unique, "Fields must be unique");
const observation = z
  .object({
    row_id: id,
    observed_at: instant,
    source_version_ids: z
      .array(id)
      .max(12)
      .refine(unique, "Source versions must be unique"),
  })
  .strict();

/** Existing findings and discovery are deliberately separate scopes. */
export const updateBeginSchema = z
  .object({
    request_id: z.string().uuid(),
    snapshot_id: id,
    expected_revision: z.number().int().nonnegative(),
    question: z.string().trim().min(1).max(1000).optional(),
    existing: z.object({ row_ids: rows, fields }).strict().optional(),
    discovery: z
      .object({
        question: z.string().trim().min(1).max(1000),
        identity_fields: fields,
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (input) => input.existing || input.discovery,
    "Choose existing findings, discovery, or both",
  );

export const updateCompletionSchema = z
  .object({
    request_id: z.string().uuid(),
    existing_snapshot: snapshotSchema.optional(),
    discovery_snapshot: snapshotSchema.optional(),
    assessments: z
      .array(
        observation
          .extend({
            field: key,
            status: z.enum(["verified", "conflicting", "unverified"]),
            note: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(12800)
      .default([]),
    discovery_observations: z.array(observation).max(100).default([]),
  })
  .strict();

export const updateReviewSchema = z
  .object({
    request_id: z.string().uuid(),
    change_id: id,
    decision: z.enum(["accept", "keep"]),
    expected_revision: z.number().int().nonnegative(),
    mutation_id: z.string().uuid(),
  })
  .strict();

export const updatePublishSchema = z
  .object({
    request_id: z.string().uuid(),
    snapshot_id: id,
    title: z.string().trim().min(1).max(150).optional(),
    expected_revision: z.number().int().nonnegative(),
    mutation_id: z.string().uuid(),
  })
  .strict();

export type UpdateBeginInput = z.infer<typeof updateBeginSchema>;
export type UpdateCompletionInput = z.infer<typeof updateCompletionSchema>;
export type UpdateReviewInput = z.infer<typeof updateReviewSchema>;
export type UpdatePublishInput = z.infer<typeof updatePublishSchema>;
export type ResearchUpdateRequest = {
  schemaVersion: 1;
  id: string;
  input: UpdateBeginInput;
  snapshotId: string;
  baseRevision: number;
  createdAt: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  baselineSnapshot: Snapshot;
  baseline: Row[];
  corrections: Amendment[];
};
/** These records must come from authorized engine metadata, never completion arguments. */
export type UpdateEvidenceContext = {
  result_id: string;
  completed_at: string;
  source_versions: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
};
export type UpdateEvidence = {
  resultId: string;
  sourceVersionId: string;
  contentSha256: string | null;
  observedAt: string;
  url: string;
  contentBasis?: string;
  quote?: string;
  evidenceId?: string;
  valueBasis?: "source_url" | "source_title";
};
export type UpdateChange = {
  id: string;
  kind:
    | "addition"
    | "changed_claim"
    | "contradiction"
    | "not_observed"
    | "unchanged";
  scope: "existing" | "discovery";
  rowId: string;
  field?: string;
  previous?: CellValue;
  proposed?: CellValue;
  proposalSnapshotId: string;
  observedAt: string;
  note: string;
  evidence: UpdateEvidence[];
  canAccept: boolean;
};
export type UpdateDecisions = Record<string, "accept" | "keep">;

function equal(a: unknown, b: unknown) {
  return canonicalJson(a) === canonicalJson(b);
}
function bounded(snapshot: Snapshot) {
  if (
    (snapshot.rowCount ?? snapshot.rows.length) !== snapshot.rows.length ||
    snapshot.rows.length > 100
  )
    throw new Error(
      "Manual updates currently require a complete bounded table of at most 100 rows; a preview is not a complete baseline.",
    );
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 200000)
    throw new Error(
      "Manual updates currently require a bounded inline table of at most 200 KB UTF-8 bytes.",
    );
}
function identity(row: Row, identityFields: string[]) {
  const values = identityFields.map((field) => {
    const value = row.values[field];
    if (
      value === null ||
      value === undefined ||
      (typeof value === "string" && !value.trim())
    )
      throw new Error(
        `Discovery identity is missing in ${row.id}.${field}; choose explicit complete identity fields.`,
      );
    if (typeof value === "object")
      throw new Error("Discovery identity fields must be scalar.");
    return typeof value === "string" ? value.trim().toLowerCase() : value;
  });
  return JSON.stringify(values);
}
export function createUpdateRequest(
  view: ResearchView,
  input: UpdateBeginInput,
  now = new Date().toISOString(),
): ResearchUpdateRequest {
  const parsed = updateBeginSchema.parse(input);
  instant.parse(now);
  if (parsed.snapshot_id !== view.snapshot.id)
    throw new Error("Update baseline snapshot does not match.");
  if (parsed.expected_revision !== view.revision)
    throw new Error(
      "Research changed; reload its current revision before checking for updates.",
    );
  bounded(view.snapshot);
  const knownFields = new Set(
    view.snapshot.columns.map((column) => column.key),
  );
  const knownRows = new Set(view.snapshot.rows.map((row) => row.id));
  for (const rowId of parsed.existing?.row_ids ?? [])
    if (!knownRows.has(rowId))
      throw new Error("Unknown existing row ID in update scope.");
  for (const field of [
    ...(parsed.existing?.fields ?? []),
    ...(parsed.discovery?.identity_fields ?? []),
  ])
    if (!knownFields.has(field))
      throw new Error("Unknown field in update scope.");
  const baseline = view.snapshot.rows.map((row) => ({
    ...structuredClone(row),
    values: Object.fromEntries(
      view.snapshot.columns.map((column) => [
        column.key,
        effectiveValue(view, row, column.key),
      ]),
    ),
    ...(sourcesForViewSelection(view, row).length
      ? { sources: sourcesForViewSelection(view, row).slice(0, 12) }
      : {}),
    cellSources: Object.fromEntries(
      view.snapshot.columns
        .map((column) => [
          column.key,
          sourcesForViewSelection(view, row, column.key).slice(0, 12),
        ])
        .filter(([, sources]) => (sources as unknown[]).length),
    ),
  }));
  if (parsed.discovery) {
    const identities = baseline.map((row) =>
      identity(row, parsed.discovery!.identity_fields),
    );
    if (!unique(identities))
      throw new Error(
        "Baseline identities are ambiguous; choose more identity fields before discovery.",
      );
  }
  return {
    schemaVersion: 1,
    id: parsed.request_id,
    input: parsed,
    snapshotId: parsed.snapshot_id,
    baseRevision: view.revision,
    createdAt: now,
    status: "pending",
    baselineSnapshot: structuredClone(view.snapshot),
    baseline,
    corrections: structuredClone(view.amendments),
  };
}

function contextFor(
  snapshot: Snapshot,
  contexts: Record<string, UpdateEvidenceContext>,
  request: ResearchUpdateRequest,
) {
  const context = contexts[snapshot.id];
  if (!context || context.result_id !== originForSnapshot(snapshot).resultId)
    throw new Error(
      "Authorized canonical source metadata is required for every update result.",
    );
  if (
    !validInstant(context.completed_at) ||
    Date.parse(context.completed_at) < Date.parse(request.createdAt)
  )
    throw new Error(
      "Update result completion must be freshly observed after this check began; relabeled old results are not a freshness check.",
    );
  if (
    new Set(context.source_versions.map((source) => source.source_version_id))
      .size !== context.source_versions.length
  )
    throw new Error("Canonical source version identity is ambiguous.");
  return context;
}
function canonicalSources(
  input: { observed_at: string; source_version_ids: string[] },
  context: UpdateEvidenceContext,
  request: ResearchUpdateRequest,
) {
  const selected = input.source_version_ids.map((sourceId) => {
    const source = context.source_versions.find(
      (candidate) => candidate.source_version_id === sourceId,
    );
    if (!source)
      throw new Error("Update references an unknown source version.");
    if (
      typeof source.retrieved_at !== "string" ||
      !validInstant(source.retrieved_at)
    )
      throw new Error(
        "Source observation time is unavailable; it cannot be claimed as a dated update.",
      );
    if (
      Date.parse(source.retrieved_at) < Date.parse(request.createdAt) ||
      Date.parse(source.retrieved_at) > Date.parse(context.completed_at)
    )
      throw new Error(
        "Update source retrieval must occur during this check; a newly executed query over old source versions is not a new observation.",
      );
    if (typeof source.url !== "string" || !/^https?:\/\//.test(source.url))
      throw new Error("Canonical source URL is unavailable.");
    if (typeof source.content === "string") {
      const hash = createHash("sha256").update(source.content).digest("hex");
      if (source.content_sha256 !== hash)
        throw new Error("Canonical source content hash mismatch.");
    }
    return source;
  });
  const observed = selected.length
    ? selected
        .map((source) => source.retrieved_at as string)
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0]
    : context.completed_at;
  if (
    !observed ||
    !validInstant(observed) ||
    Date.parse(observed) !== Date.parse(input.observed_at)
  )
    throw new Error(
      "Update observation time must match the canonical source retrieval time, or completed run time when no source was observed.",
    );
  return selected;
}
function reference(
  context: UpdateEvidenceContext,
  source: Record<string, unknown>,
): UpdateEvidence {
  return {
    resultId: context.result_id,
    sourceVersionId: source.source_version_id as string,
    contentSha256:
      typeof source.content_sha256 === "string" ? source.content_sha256 : null,
    observedAt: source.retrieved_at as string,
    url: source.url as string,
    ...(typeof source.content_basis === "string"
      ? { contentBasis: source.content_basis }
      : {}),
  };
}
function supportedField(
  row: Row,
  field: string,
  selected: Record<string, unknown>[],
  context: UpdateEvidenceContext,
  allowMetadata = false,
): UpdateEvidence[] {
  const quotes = (row.evidence[field] ?? []).filter((quote) => quote.trim());
  if (!quotes.length && allowMetadata) {
    const source = selected.find(
      (candidate) =>
        row.values[field] === candidate.url ||
        (typeof candidate.title === "string" &&
          row.values[field] === candidate.title),
    );
    if (source)
      return [
        {
          ...reference(context, source),
          valueBasis:
            row.values[field] === source.url ? "source_url" : "source_title",
        },
      ];
  }
  if (!quotes.length)
    throw new Error(
      "Supported update fields require returned textual source evidence.",
    );
  return quotes.map((quote) => {
    const candidates = selected.filter(
      (source) =>
        typeof source.content === "string" && source.content.includes(quote),
    );
    if (!candidates.length)
      throw new Error(
        "Update quote does not occur in its canonical source version.",
      );
    const direct = context.evidence.find(
      (entry) =>
        (!entry.row_id || entry.row_id === row.id) &&
        ((!entry.column_key && !entry.field) ||
          (entry.column_key ?? entry.field) === field) &&
        candidates.some(
          (source) => source.source_version_id === entry.source_version_id,
        ) &&
        [entry.support, entry.support_spans].some(
          (spans) =>
            Array.isArray(spans) &&
            spans.some(
              (span) =>
                span &&
                typeof span === "object" &&
                (span as Record<string, unknown>).quote === quote,
            ),
        ),
    );
    const source = direct
      ? candidates.find(
          (candidate) =>
            candidate.source_version_id === direct.source_version_id,
        )!
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!source)
      throw new Error(
        "Update quote matches ambiguous source versions; supply direct canonical evidence attribution.",
      );
    return {
      ...reference(context, source),
      quote,
      ...(direct && typeof (direct.evidence_id ?? direct.id) === "string"
        ? { evidenceId: String(direct.evidence_id ?? direct.id) }
        : {}),
    };
  });
}
function changeId(
  request: ResearchUpdateRequest,
  scope: string,
  rowId: string,
  field?: string,
) {
  return (
    "uc_" +
    createHash("sha256")
      .update(JSON.stringify([request.id, scope, rowId, field ?? null]))
      .digest("hex")
      .slice(0, 32)
  );
}

/** Validate full result identity, both scopes, and canonical evidence; never infer a merge. */
export function validateUpdateCompletion(
  request: ResearchUpdateRequest,
  input: UpdateCompletionInput,
  contexts: Record<string, UpdateEvidenceContext>,
): UpdateCompletionInput {
  const completion = updateCompletionSchema.parse(input);
  if (completion.request_id !== request.id)
    throw new Error("Update completion request ID does not match.");
  if (request.status === "failed" || request.status === "cancelled")
    throw new Error("This update request is closed; late results are refused.");
  if (
    Boolean(completion.existing_snapshot) !== Boolean(request.input.existing) ||
    Boolean(completion.discovery_snapshot) !== Boolean(request.input.discovery)
  )
    throw new Error(
      "Return exactly the existing and discovery scopes requested; they cannot substitute for one another.",
    );
  const snapshots = [
    completion.existing_snapshot,
    completion.discovery_snapshot,
  ].filter((snapshot): snapshot is Snapshot => !!snapshot);
  if (!unique(snapshots.map((snapshot) => snapshot.id)))
    throw new Error(
      "Existing findings and discovery require separate immutable result snapshots.",
    );
  for (const snapshot of snapshots) {
    bounded(snapshot);
    if (
      snapshot.id === request.snapshotId ||
      originForSnapshot(snapshot).resultId ===
        originForSnapshot(request.baselineSnapshot).resultId
    )
      throw new Error(
        "An update requires newly observed results; the saved baseline alone is not a freshness check.",
      );
    if (
      snapshot.parentSnapshotId &&
      snapshot.parentSnapshotId !== request.snapshotId
    )
      throw new Error("Update result belongs to a different baseline.");
    if (!equal(snapshot.columns, request.baselineSnapshot.columns))
      throw new Error(
        "Update results must preserve the baseline's column definitions.",
      );
    contextFor(snapshot, contexts, request);
  }
  if (!request.input.existing && completion.assessments.length)
    throw new Error(
      "Existing-field assessments are outside this discovery-only scope.",
    );
  if (!request.input.discovery && completion.discovery_observations.length)
    throw new Error(
      "Discovery observations are outside this existing-findings-only scope.",
    );
  if (completion.existing_snapshot) {
    const snapshot = completion.existing_snapshot;
    const scope = request.input.existing!;
    if (
      snapshot.rows.length !== scope.row_ids.length ||
      snapshot.rows.some((row) => !scope.row_ids.includes(row.id))
    )
      throw new Error(
        "Existing updates must return every exact scoped row ID, without additions, omissions or re-keying.",
      );
    const expected = new Set(
      scope.row_ids.flatMap((rowId) =>
        scope.fields.map((field) => JSON.stringify([rowId, field])),
      ),
    );
    const context = contextFor(snapshot, contexts, request);
    for (const row of snapshot.rows) {
      const baseline = request.baseline.find(
        (candidate) => candidate.id === row.id,
      )!;
      for (const column of snapshot.columns)
        if (
          !scope.fields.includes(column.key) &&
          !equal(row.values[column.key], baseline.values[column.key])
        )
          throw new Error(
            "Fields outside the update scope must retain their baseline values.",
          );
    }
    for (const assessment of completion.assessments) {
      if (
        !expected.delete(JSON.stringify([assessment.row_id, assessment.field]))
      )
        throw new Error("Unexpected or duplicate existing-field assessment.");
      const proposed = snapshot.rows.find(
        (row) => row.id === assessment.row_id,
      )!;
      const baseline = request.baseline.find(
        (row) => row.id === assessment.row_id,
      )!;
      const sources = canonicalSources(assessment, context, request);
      if (assessment.status === "unverified") {
        if (
          !equal(
            proposed.values[assessment.field],
            baseline.values[assessment.field],
          )
        )
          throw new Error(
            "Not-observed/unverified fields must retain their baseline value; absence is not deletion.",
          );
      } else {
        if (!sources.length)
          throw new Error(
            "Verified or contradictory claims require canonical source versions.",
          );
        supportedField(proposed, assessment.field, sources, context);
      }
    }
    if (expected.size)
      throw new Error(
        "Assess every requested existing row and field, including findings not observed.",
      );
  }
  if (completion.discovery_snapshot) {
    const snapshot = completion.discovery_snapshot;
    const context = contextFor(snapshot, contexts, request);
    const identityFields = request.input.discovery!.identity_fields;
    const identities = new Set(
      request.baseline.map((row) => identity(row, identityFields)),
    );
    const rowIds = new Set(request.baseline.map((row) => row.id));
    const pending = new Set(snapshot.rows.map((row) => row.id));
    for (const row of snapshot.rows) {
      if (rowIds.has(row.id))
        throw new Error(
          "Discovery row IDs collide with existing canonical rows.",
        );
      const value = identity(row, identityFields);
      if (identities.has(value))
        throw new Error(
          "Discovery identity overlaps the baseline or another candidate; resolve it explicitly instead of guessing a merge.",
        );
      identities.add(value);
    }
    for (const observation of completion.discovery_observations) {
      if (!pending.delete(observation.row_id))
        throw new Error("Unexpected or duplicate discovery observation.");
      const row = snapshot.rows.find(
        (candidate) => candidate.id === observation.row_id,
      )!;
      const sources = canonicalSources(observation, context, request);
      if (!sources.length)
        throw new Error("Additions require canonical source versions.");
      for (const column of snapshot.columns)
        if (row.values[column.key] !== null)
          supportedField(row, column.key, sources, context, true);
    }
    if (pending.size)
      throw new Error(
        "Provide a source-version observation for every discovered row.",
      );
  }
  return completion;
}

export function deriveUpdateChanges(
  request: ResearchUpdateRequest,
  input: UpdateCompletionInput,
  contexts: Record<string, UpdateEvidenceContext>,
): UpdateChange[] {
  const completion = validateUpdateCompletion(request, input, contexts);
  const changes: UpdateChange[] = [];
  if (completion.existing_snapshot) {
    const snapshot = completion.existing_snapshot;
    const context = contextFor(snapshot, contexts, request);
    for (const assessment of completion.assessments) {
      const row = snapshot.rows.find(
        (candidate) => candidate.id === assessment.row_id,
      )!;
      const previous = request.baseline.find(
        (candidate) => candidate.id === row.id,
      )!.values[assessment.field];
      const proposed = row.values[assessment.field];
      const kind =
        assessment.status === "unverified"
          ? "not_observed"
          : assessment.status === "conflicting"
            ? "contradiction"
            : equal(previous, proposed)
              ? "unchanged"
              : "changed_claim";
      const selected = canonicalSources(assessment, context, request);
      changes.push({
        id: changeId(request, "existing", row.id, assessment.field),
        kind,
        scope: "existing",
        rowId: row.id,
        field: assessment.field,
        previous: structuredClone(previous),
        proposed: structuredClone(proposed),
        proposalSnapshotId: snapshot.id,
        observedAt: assessment.observed_at,
        note: assessment.note,
        evidence:
          assessment.status === "unverified"
            ? selected.map((source) => reference(context, source))
            : supportedField(row, assessment.field, selected, context),
        canAccept: kind === "changed_claim",
      });
    }
  }
  if (completion.discovery_snapshot) {
    const snapshot = completion.discovery_snapshot;
    const context = contextFor(snapshot, contexts, request);
    for (const row of snapshot.rows) {
      const observation = completion.discovery_observations.find(
        (candidate) => candidate.row_id === row.id,
      )!;
      const selected = canonicalSources(observation, context, request);
      const evidence = snapshot.columns.flatMap((column) =>
        row.values[column.key] === null
          ? []
          : supportedField(row, column.key, selected, context, true),
      );
      changes.push({
        id: changeId(request, "discovery", row.id),
        kind: "addition",
        scope: "discovery",
        rowId: row.id,
        proposed: structuredClone(row.values),
        proposalSnapshotId: snapshot.id,
        observedAt: observation.observed_at,
        note: "New candidate with a distinct explicit identity; acceptance adds it only to a reviewed successor table.",
        evidence,
        canAccept: true,
      });
    }
  }
  return changes;
}

export function validateUpdateDecision(
  changes: UpdateChange[],
  input: UpdateReviewInput,
): UpdateChange {
  const review = updateReviewSchema.parse(input);
  const change = changes.find((candidate) => candidate.id === review.change_id);
  if (!change) throw new Error("Update proposal not found.");
  if (review.decision === "accept" && !change.canAccept)
    throw new Error(
      "This proposal has no supported change to accept. Keep not-observed/unchanged findings; resolve contradictory evidence with an explicit correction.",
    );
  return change;
}

function inferredType(values: CellValue[]) {
  const present = values.filter((value) => value !== null);
  if (present.every((value) => typeof value === "string")) return "VARCHAR";
  if (present.every((value) => typeof value === "number")) return "DOUBLE";
  if (present.every((value) => typeof value === "boolean")) return "BOOLEAN";
  return "JSON";
}
/** Build a bounded, honest application-composed successor. No baseline object is mutated. */
export function buildAcceptedUpdateSnapshot(
  request: ResearchUpdateRequest,
  completion: UpdateCompletionInput,
  changes: UpdateChange[],
  decisions: UpdateDecisions,
  currentView: ResearchView,
  input: UpdatePublishInput,
  now = new Date().toISOString(),
): Snapshot {
  const publish = updatePublishSchema.parse(input);
  instant.parse(now);
  if (
    publish.request_id !== request.id ||
    currentView.snapshot.id !== request.snapshotId
  )
    throw new Error("Update publication baseline does not match.");
  if (
    currentView.revision !== request.baseRevision ||
    publish.expected_revision !== request.baseRevision
  )
    throw new Error(
      "The baseline has changed since this check. Review a new update request against its current amendments.",
    );
  if (
    publish.snapshot_id === request.snapshotId ||
    [
      completion.existing_snapshot?.id,
      completion.discovery_snapshot?.id,
    ].includes(publish.snapshot_id)
  )
    throw new Error(
      "Publish the accepted update as a new immutable successor snapshot.",
    );
  if (
    Object.keys(decisions).some(
      (changeId) => !changes.some((change) => change.id === changeId),
    )
  )
    throw new Error("Review contains an unknown update proposal.");
  const acceptedRows = structuredClone(request.baseline);
  for (const change of changes) {
    const decision = decisions[change.id];
    if (decision !== "accept" && decision !== "keep")
      throw new Error(
        "Review every update proposal before publishing the successor.",
      );
    if (decision !== "accept") continue;
    if (!change.canAccept)
      throw new Error(
        "A contradictory, unchanged or not-observed finding cannot be accepted as an update.",
      );
    if (change.kind === "addition") {
      const row = completion.discovery_snapshot?.rows.find(
        (candidate) => candidate.id === change.rowId,
      );
      if (!row)
        throw new Error(
          "Accepted addition is missing its immutable proposal row.",
        );
      acceptedRows.push(structuredClone(row));
    } else if (change.kind === "changed_claim" && change.field) {
      const row = acceptedRows.find(
        (candidate) => candidate.id === change.rowId,
      )!;
      const proposed = completion.existing_snapshot?.rows.find(
        (candidate) => candidate.id === change.rowId,
      );
      if (!proposed)
        throw new Error(
          "Accepted claim is missing its immutable proposal row.",
        );
      row.values[change.field] = structuredClone(proposed.values[change.field]);
      row.evidence[change.field] = structuredClone(
        proposed.evidence[change.field] ?? [],
      );
      const sources = change.evidence.map((entry) => ({ url: entry.url }));
      row.cellSources = {
        ...row.cellSources,
        [change.field]: [
          ...new Map(sources.map((source) => [source.url, source])).values(),
        ].slice(0, 12),
      };
      row.evidenceRefs = [
        ...new Set([
          ...(row.evidenceRefs ?? []),
          ...(proposed.evidenceRefs ?? []),
        ]),
      ];
    }
  }
  if (acceptedRows.length > 100)
    throw new Error(
      "Accepted successor exceeds the current 100-row inline limit. Keep fewer additions or use an engine-backed materialization path.",
    );
  const dependencies = [
    request.baselineSnapshot,
    completion.existing_snapshot,
    completion.discovery_snapshot,
  ].filter((snapshot): snapshot is Snapshot => !!snapshot);
  const privateSource = dependencies.some((snapshot) =>
    snapshot.dataClassification?.startsWith("private_"),
  );
  const syntheticOnly = dependencies.every(
    (snapshot) =>
      snapshot.dataClassification === "synthetic_fixture" ||
      (!snapshot.schemaVersion &&
        snapshot.rows.every(
          (row) =>
            row.sourceUrl?.startsWith("https://example.com/") &&
            row.verificationNote.toLowerCase().includes("synthetic"),
        )),
  );
  const snapshot: Snapshot = {
    schemaVersion: 2,
    id: publish.snapshot_id,
    title:
      publish.title ??
      `${currentView.displayTitle.slice(0, 120)} — accepted update`,
    origin: {
      engine: "imported",
      resultId: "update_" + request.id.replaceAll("-", ""),
      runId: null,
    },
    capturedAt: now,
    capturePrecision: "instant",
    captureBasis: "imported_declared_time",
    parentSnapshotId: request.snapshotId,
    rowCount: acceptedRows.length,
    dataClassification: privateSource
      ? "private_derived"
      : syntheticOnly
        ? "synthetic_fixture"
        : "public_web",
    coverage: {
      planComplete: true,
      corpusComplete: "unknown",
      notes: [
        "Application-composed successor after explicit review; publication time is not a new source observation.",
        "Original observations, amendments and the versioned update change set remain separate retained dependencies.",
        "Findings not observed during the check were kept; missing search hits do not establish deletion.",
        `Update request ${request.id}; baseline revision ${request.baseRevision}.`,
      ],
    },
    columns: request.baselineSnapshot.columns.map((column) => ({
      ...column,
      logicalType:
        column.logicalType ??
        inferredType(acceptedRows.map((row) => row.values[column.key])),
      nullable: column.nullable ?? true,
    })),
    rows: acceptedRows,
    previewOffset: 0,
  };
  bounded(snapshot);
  return snapshotSchema.parse(snapshot);
}
