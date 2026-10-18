import { useLayoutEffect, useState } from "react";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { Button } from "./ui.js";

export type ResearchStatus = {
  message: string;
  kind: "pending" | "error" | "cancelled";
  pendingRequestIds: string[];
  canCheck: boolean;
  canDismiss: boolean;
};

export function ResearchStatusOverlay({
  status,
  busy,
  onCheck,
  onCancel,
  onDismiss,
}: {
  status?: ResearchStatus;
  busy: boolean;
  onCheck: () => void;
  onCancel: (requestId: string) => void;
  onDismiss: () => void;
}) {
  // Keep the last content in place while the floating controls animate away.
  const [content, setContent] = useState(status);
  useLayoutEffect(() => {
    if (status) setContent(status);
  }, [status]);
  const visible = Boolean(status);
  const displayed = status ?? content;
  return (
    <div
      className="research-status-layer"
      data-state={visible ? "visible" : "hidden"}
    >
      <div
        className="research-status"
        data-kind={displayed?.kind}
        data-state={visible ? "visible" : "hidden"}
        aria-hidden={!visible}
        inert={!visible}
      >
        <div
          className="research-status-message"
          role={displayed?.kind === "error" ? "alert" : "status"}
          aria-atomic="true"
        >
          {displayed?.kind === "pending" ? (
            <LoaderCircle className="research-spinner" aria-hidden="true" />
          ) : displayed?.kind === "error" ? (
            <CircleAlert aria-hidden="true" />
          ) : null}
          <span>{displayed?.message}</span>
        </div>
        <div className="research-status-actions">
          {displayed?.canCheck && (
            <Button
              variant="ghost"
              aria-label="Check research status"
              disabled={busy}
              onClick={onCheck}
            >
              Check
            </Button>
          )}
          {displayed?.pendingRequestIds.map((requestId) => (
            <Button
              key={requestId}
              variant="ghost"
              aria-label="Cancel research request"
              title="Cancel this request and stop accepting its results"
              disabled={busy}
              onClick={() => onCancel(requestId)}
            >
              Cancel
            </Button>
          ))}
          {displayed?.canDismiss && (
            <Button
              variant="ghost"
              className="dismiss-research-status"
              aria-label="Dismiss cancelled research status"
              onClick={onDismiss}
            >
              <X aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
