import { useState } from "react";
import { X } from "lucide-react";
import {
  HOST_ASSERTED_LABEL,
  HOST_ASSERTED_TITLE,
  LEAD_SET_EMPTY,
  LEAD_SET_NOTE,
  hostAssertedColumn,
} from "./presentation.js";
import type { Snapshot } from "./schema.js";

/** Real header text, so a screen reader reads it with the column name. */
export function LeadColumnLabel({
  snapshot,
  field,
}: {
  snapshot: Snapshot;
  field: string;
}) {
  if (!hostAssertedColumn(snapshot, field)) return null;
  return (
    <span className="column-assertion" title={HOST_ASSERTED_TITLE}>
      {HOST_ASSERTED_LABEL}
    </span>
  );
}

/** Where the set stands, and a dismissible note that these rows are not citations. */
export function LeadSetBanner({
  leadSet,
  queueLine,
}: {
  leadSet: NonNullable<Snapshot["leadSet"]>;
  queueLine: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  return (
    <div className="lead-set-banner" data-lead-set={leadSet.leadSetId}>
      <p className="lead-set-queue">{queueLine}</p>
      {!dismissed && (
        <p className="lead-set-note">
          <span>{LEAD_SET_NOTE}</span>
          <button
            type="button"
            className="lead-set-dismiss"
            aria-label="Dismiss note"
            onClick={() => setDismissed(true)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </p>
      )}
    </div>
  );
}

export function LeadSetEmpty() {
  return (
    <div className="empty">
      <p>{LEAD_SET_EMPTY}</p>
    </div>
  );
}

/** The reason a failed lead failed, for the status cell's tooltip and the detail panel. */
export function leadFetchFailure(values: Record<string, unknown>) {
  return values.lead_status === "failed" &&
    typeof values.fetch_failure === "string" &&
    values.fetch_failure
    ? values.fetch_failure
    : undefined;
}
