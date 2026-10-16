import { useEffect, useState } from "react";
import { Check, ExternalLink, ArrowRight } from "lucide-react";
import { Button } from "./ui.js";
import { displayValue, type CellValue, type ResearchView } from "./schema.js";
import { humanizeColumnLabel } from "./presentation.js";
import type {
  UpdateBeginInput,
  UpdateChange,
  UpdateEvidence,
} from "../server/updates.js";

type UpdateReview = NonNullable<ResearchView["update"]>;
export function manualUpdateAvailability(
  view: ResearchView,
  canAskAgent: boolean,
): { available: boolean; reason?: string } {
  if (!canAskAgent)
    return {
      available: false,
      reason: "Open in a host with agent messaging to check for updates.",
    };
  const total =
    view.preview?.total ?? view.snapshot.rowCount ?? view.snapshot.rows.length;
  if (
    total > 100 ||
    total !== view.snapshot.rows.length ||
    (view.snapshot.rowCount !== undefined &&
      view.snapshot.rowCount !== view.snapshot.rows.length) ||
    (view.preview?.offset ?? 0) !== 0 ||
    (view.preview?.nextOffset ?? null) !== null ||
    new TextEncoder().encode(JSON.stringify(view.snapshot)).byteLength > 200000
  )
    return {
      available: false,
      reason:
        "Updates need a complete table of at most 100 rows and 200 KB. Save a smaller SQL projection first; a preview is not a complete baseline.",
    };
  return { available: true };
}
export function manualUpdateArguments(
  view: ResearchView,
  options: {
    requestId: string;
    question: string;
    existing: boolean;
    discovery: boolean;
    identityFields: string[];
    rowId?: string;
    field?: string;
  },
): UpdateBeginInput {
  if (!options.existing && !options.discovery)
    throw new Error("Choose existing findings, new entities, or both.");
  const availability = manualUpdateAvailability(view, true);
  if (!availability.available) throw new Error(availability.reason);
  if (
    options.rowId &&
    !view.snapshot.rows.some((row) => row.id === options.rowId)
  )
    throw new Error(
      "The selected canonical row is no longer available. Reopen the table.",
    );
  if (
    options.field &&
    (!options.rowId ||
      !view.snapshot.columns.some((column) => column.key === options.field))
  )
    throw new Error("Select a declared field and its canonical row.");
  if (options.existing && view.snapshot.rows.length === 0)
    throw new Error(
      "There are no existing findings to revisit. Choose discovery to check for new entities.",
    );
  const question = options.question.trim();
  if (!question || question.length > 1000)
    throw new Error("Describe the update check in 1–1,000 characters.");
  if (
    options.discovery &&
    (!options.identityFields.length ||
      new Set(options.identityFields).size !== options.identityFields.length ||
      options.identityFields.some(
        (field) =>
          !view.snapshot.columns.some((column) => column.key === field),
      ))
  )
    throw new Error(
      "Choose the column keys that identify an entity before discovering additions.",
    );
  return {
    request_id: options.requestId,
    snapshot_id: view.snapshot.id,
    expected_revision: view.revision,
    question,
    ...(options.existing
      ? {
          existing: {
            row_ids: options.rowId
              ? [options.rowId]
              : view.snapshot.rows.map((row) => row.id),
            fields: options.field
              ? [options.field]
              : view.snapshot.columns.map((column) => column.key),
          },
        }
      : {}),
    ...(options.discovery
      ? { discovery: { question, identity_fields: options.identityFields } }
      : {}),
  };
}
export function updateReviewReadiness(update: UpdateReview) {
  const unreviewed = update.changes.filter(
    (change) => !["accept", "keep"].includes(update.decisions[change.id]),
  ).length;
  const invalidAccept = update.changes.some(
    (change) => update.decisions[change.id] === "accept" && !change.canAccept,
  );
  return {
    unreviewed,
    canPublish:
      !update.stale &&
      !update.publishedSnapshotId &&
      unreviewed === 0 &&
      !invalidAccept,
  };
}
const changeLabels: Record<UpdateChange["kind"], string> = {
  addition: "New entity",
  changed_claim: "Changed claim",
  contradiction: "Contradictory evidence",
  not_observed: "Not observed",
  unchanged: "Unchanged",
};
function safeSource(url: string) {
  try {
    return ["https:", "http:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
export function additionFields(
  change: UpdateChange,
  columns: { key: string; label: string }[],
) {
  if (
    change.kind !== "addition" ||
    !change.proposed ||
    typeof change.proposed !== "object" ||
    Array.isArray(change.proposed)
  )
    return [];
  const values = change.proposed as Record<string, CellValue>;
  const ordered = [
    ...columns.filter((column) => Object.hasOwn(values, column.key)),
    ...Object.keys(values)
      .filter((key) => !columns.some((column) => column.key === key))
      .map((key) => ({ key, label: humanizeColumnLabel(key) })),
  ];
  return ordered.map((column) => ({ ...column, value: values[column.key] }));
}
/** One quote per source version; retain every distinct source URL and observation. */
export function groupUpdateEvidence(evidence: UpdateEvidence[]) {
  const groups = new Map<
    string,
    { sourceVersionId: string; quote?: string; links: UpdateEvidence[] }
  >();
  for (const item of evidence) {
    const key = JSON.stringify([item.sourceVersionId, item.quote ?? null]);
    let group = groups.get(key);
    if (!group) {
      group = {
        sourceVersionId: item.sourceVersionId,
        quote: item.quote,
        links: [],
      };
      groups.set(key, group);
    }
    if (
      !group.links.some(
        (link) =>
          link.url === item.url &&
          link.observedAt === item.observedAt &&
          link.contentBasis === item.contentBasis,
      )
    )
      group.links.push(item);
  }
  return [...groups.values()];
}
export function UpdateReviewPanel({
  update,
  columns,
  busy,
  onReview,
  onPublish,
  onSource,
  onOpenPublished,
}: {
  update: UpdateReview;
  columns: { key: string; label: string }[];
  busy: boolean;
  onReview(changeId: string, decision: "accept" | "keep"): void;
  onPublish(): void;
  onSource(url: string): void;
  onOpenPublished(snapshotId: string): void;
}) {
  const { unreviewed, canPublish } = updateReviewReadiness(update);
  const published = Boolean(update.publishedSnapshotId);
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [update.requestId]);
  const pageCount = Math.max(1, Math.ceil(update.changes.length / 10));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleChanges = update.changes.slice(
    currentPage * 10,
    (currentPage + 1) * 10,
  );
  return (
    <section
      className="update-review"
      aria-label={
        published
          ? "Published update review history"
          : "Review evidence-backed updates"
      }
    >
      <div className="update-review-heading">
        <div>
          <strong>{published ? "Published update" : "Review updates"}</strong>
          <p>
            {update.parentTitle} ·{" "}
            {published ? "review history" : `${unreviewed} to review`}
          </p>
        </div>
        {update.publishedSnapshotId ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => onOpenPublished(update.publishedSnapshotId!)}
          >
            Open published update <ArrowRight size={14} />
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy || !canPublish}
            onClick={onPublish}
          >
            Publish accepted update <ArrowRight size={14} />
          </Button>
        )}
      </div>
      {published ? (
        <p className="update-review-note">
          Published from baseline revision {update.baseRevision}. Review
          decisions and evidence are retained.
        </p>
      ) : update.stale ? (
        <p className="update-stale" role="status">
          The baseline has newer corrections. Start a new check from that table
          before accepting or publishing these proposals.
        </p>
      ) : (
        <p className="update-review-note">
          Review each finding before publishing a new saved table. Earlier
          observations and corrections are preserved.
        </p>
      )}
      <div className="update-change-list">
        {update.changes.length ? (
          visibleChanges.map((change) => {
            const decision = update.decisions[change.id],
              label =
                columns.find((column) => column.key === change.field)?.label ??
                change.field ??
                "Entire entity";
            const addedFields = additionFields(change, columns);
            const identityField =
              addedFields.find(
                (entry) =>
                  /^(name|entity_name|project|project_name|utility_name|company_name|organization_name|facility_name|title|issuer)$/.test(
                    entry.key,
                  ) &&
                  entry.value !== null &&
                  String(entry.value).trim(),
              ) ??
              addedFields.find(
                (entry) =>
                  entry.value !== null &&
                  typeof entry.value !== "object" &&
                  String(entry.value).trim(),
              );
            const additionLabel = identityField
              ? displayValue(identityField.value)
              : change.rowId;
            return (
              <details key={change.id} className="update-change">
                <summary>
                  <span className="update-kind">
                    {changeLabels[change.kind]}
                  </span>
                  <span>
                    {change.kind === "addition"
                      ? additionLabel
                      : `${label} · ${change.rowId}`}
                  </span>
                  {decision && (
                    <span className="update-decision">
                      <Check size={12} />
                      {decision === "accept" ? "Accepted" : "Kept"}
                    </span>
                  )}
                </summary>
                <div className="update-change-body">
                  <p className="update-observed">
                    Observed{" "}
                    <time dateTime={change.observedAt}>
                      {new Date(change.observedAt).toLocaleString()}
                    </time>{" "}
                    ·{" "}
                    {change.scope === "discovery"
                      ? "Discovery"
                      : "Existing finding"}
                  </p>
                  {change.kind === "addition" &&
                    (addedFields.length ? (
                      <div
                        className="review-values"
                        aria-label="New entity values"
                      >
                        {addedFields.map((entry) => (
                          <div key={entry.key}>
                            <small>{entry.label}</small>
                            <p>{displayValue(entry.value)}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="review-note">
                        No proposed entity values were returned. Reopen the
                        proposal before accepting this addition.
                      </p>
                    ))}
                  {change.kind !== "not_observed" &&
                    change.kind !== "addition" && (
                      <div className="review-values">
                        <div>
                          <small>Previous</small>
                          <p>{displayValue(change.previous)}</p>
                        </div>
                        <div>
                          <small>Proposed</small>
                          <p>{displayValue(change.proposed)}</p>
                        </div>
                      </div>
                    )}
                  <p className="review-note">{change.note}</p>
                  {change.kind === "not_observed" && (
                    <p className="review-note">
                      Not observed during this check does not establish deletion
                      or cancellation.
                    </p>
                  )}
                  <div className="update-evidence">
                    {groupUpdateEvidence(change.evidence).map(
                      (group, index) => (
                        <div key={`${group.sourceVersionId}:${index}`}>
                          {group.quote && (
                            <blockquote>{group.quote}</blockquote>
                          )}
                          {group.links.map((evidence, linkIndex) => (
                            <div key={`${evidence.url}:${linkIndex}`}>
                              {safeSource(evidence.url) && (
                                <a
                                  href={evidence.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(event) => {
                                    event.preventDefault();
                                    onSource(evidence.url);
                                  }}
                                >
                                  {new URL(evidence.url).hostname}
                                  <ExternalLink size={12} />
                                </a>
                              )}
                              <small>
                                <time dateTime={evidence.observedAt}>
                                  {new Date(
                                    evidence.observedAt,
                                  ).toLocaleString()}
                                </time>{" "}
                                ·{" "}
                                {evidence.contentBasis === "excerpt" ||
                                evidence.contentBasis === "search_excerpt"
                                  ? "Excerpt evidence"
                                  : "Retained source evidence"}
                              </small>
                            </div>
                          ))}
                        </div>
                      ),
                    )}
                  </div>
                  <div className="review-actions">
                    <Button
                      variant={decision === "keep" ? "primary" : "default"}
                      aria-pressed={decision === "keep"}
                      disabled={
                        busy ||
                        update.stale ||
                        Boolean(update.publishedSnapshotId)
                      }
                      onClick={() => onReview(change.id, "keep")}
                    >
                      {change.kind === "addition"
                        ? "Skip addition"
                        : "Keep current"}
                    </Button>
                    <Button
                      variant={decision === "accept" ? "primary" : "default"}
                      aria-pressed={decision === "accept"}
                      disabled={
                        busy ||
                        update.stale ||
                        Boolean(update.publishedSnapshotId) ||
                        !change.canAccept ||
                        (change.kind === "addition" && !addedFields.length)
                      }
                      title={
                        change.canAccept
                          ? "Accept this evidence-backed change"
                          : "This finding cannot be accepted as a change; keep it or resolve the evidence separately"
                      }
                      onClick={() => onReview(change.id, "accept")}
                    >
                      Accept change
                    </Button>
                  </div>
                </div>
              </details>
            );
          })
        ) : (
          <p className="muted-note">
            No changes were proposed in this bounded check.
          </p>
        )}
      </div>
      {pageCount > 1 && (
        <div className="update-review-pages" aria-label="Update proposal pages">
          <Button
            variant="ghost"
            disabled={busy || currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous findings
          </Button>
          <span>
            {currentPage + 1} / {pageCount}
          </span>
          <Button
            variant="ghost"
            disabled={busy || currentPage + 1 >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            Next findings
          </Button>
        </div>
      )}
    </section>
  );
}
