import { useEffect, useLayoutEffect, useState } from "react";
import { Check, CircleAlert, LoaderCircle, X } from "lucide-react";
import { Button } from "./ui.js";

type FeedbackKind = "success" | "error" | "progress";

export function FeedbackToast({
  message,
  kind,
  onDismiss,
}: {
  message: string;
  kind: FeedbackKind;
  onDismiss: () => void;
}) {
  // Retain the last message while the overlay animates out.
  const [content, setContent] = useState({ message, kind });
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useLayoutEffect(() => {
    if (message) setContent({ message, kind });
  }, [message, kind]);
  useEffect(() => {
    if (!message || kind !== "success" || hovered || focused) return;
    const timer = window.setTimeout(onDismiss, 6000);
    return () => window.clearTimeout(timer);
  }, [message, kind, hovered, focused, onDismiss]);

  const visible = Boolean(message);
  const Icon =
    content.kind === "error"
      ? CircleAlert
      : content.kind === "progress"
        ? LoaderCircle
        : Check;
  return (
    <div className="feedback-layer">
      <div
        className={`feedback-toast ${content.kind}`}
        data-state={visible ? "visible" : "hidden"}
        role={content.kind === "error" ? "alert" : "status"}
        aria-atomic="true"
        aria-hidden={!visible}
        inert={!visible}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setFocused(false);
        }}
      >
        <Icon
          className={content.kind === "progress" ? "research-spinner" : ""}
          aria-hidden="true"
        />
        <span className="feedback-message">{content.message}</span>
        {content.kind !== "progress" && (
          <Button
            variant="ghost"
            aria-label="Dismiss notification"
            onClick={onDismiss}
          >
            <X />
          </Button>
        )}
      </div>
    </div>
  );
}
