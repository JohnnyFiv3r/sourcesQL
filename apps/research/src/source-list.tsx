import { ExternalLink } from "lucide-react";
import { HOST_ASSERTED_LABEL, HOST_ASSERTED_TITLE } from "./presentation.js";
import type { AssertedSource } from "./schema.js";

export function SourceList({
  sources,
  busy,
  onVisit,
}: {
  sources: AssertedSource[];
  busy: boolean;
  onVisit: (url: string) => void;
}) {
  return (
    <div className="source-list" aria-busy={busy}>
      {sources.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            if (!busy) onVisit(source.url);
          }}
        >
          <span>
            <strong>{source.label || new URL(source.url).hostname}</strong>
            <small>{source.url}</small>
            {source.assertion === "host" && (
              <small className="source-assertion" title={HOST_ASSERTED_TITLE}>
                {HOST_ASSERTED_LABEL}
              </small>
            )}
          </span>
          <ExternalLink size={16} />
        </a>
      ))}
    </div>
  );
}
