import { useEffect, useLayoutEffect, useState } from "react";
import { ExternalLink, Info, X } from "lucide-react";
import type { UsageNotice } from "./usage.js";
import { Button } from "./ui.js";

const DISMISSALS = "sourcesqlUsageNoticeDismissalsV1";
// The MCP Apps protocol does not require persistent widget state. Keep
// dismissals across table/job navigation for this card even without it.
const cardDismissals = new Set<string>();
const BILLING_DESTINATIONS = {
  exa: { name: "Exa", href: "https://dashboard.exa.ai/billing" },
  motherduck: {
    name: "MotherDuck",
    href: "https://app.motherduck.com/settings/billing",
  },
} as const;

type WidgetStateHost = {
  widgetState?: unknown;
  setWidgetState?: (state: Record<string, unknown>) => Promise<void> | void;
};
function widgetStateHost(): WidgetStateHost | undefined {
  if (typeof window === "undefined") return;
  return (window as Window & { openai?: WidgetStateHost }).openai;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Receipt IDs can change between cards; the allowance period is the identity.
export function usageNoticeKey(notice: UsageNotice): string {
  return [
    notice.service,
    notice.period,
    notice.period_start,
    notice.period_end,
  ].join("|");
}
export function dismissedUsageNoticeKeys(state: unknown): string[] {
  const values = record(state)[DISMISSALS];
  return Array.isArray(values)
    ? [
        ...new Set(
          values.filter((value): value is string => typeof value === "string"),
        ),
      ]
    : [];
}
export function withDismissedUsageNotice(
  state: unknown,
  key: string,
): Record<string, unknown> {
  return {
    ...record(state),
    [DISMISSALS]: [...new Set([...dismissedUsageNoticeKeys(state), key])],
  };
}
export function firstUndismissedUsageNotice(
  notices: readonly UsageNotice[] | undefined,
  dismissed: readonly string[],
): UsageNotice | undefined {
  return notices?.find((notice) => !dismissed.includes(usageNoticeKey(notice)));
}
function usageLabel(notice: UsageNotice): string {
  const format = (value: number) => {
    if (notice.unit === "microusd")
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value / 1_000_000);
    return value >= 60
      ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 60)} min`
      : `${new Intl.NumberFormat().format(value)} sec`;
  };
  return `${format(notice.used)} / ${format(notice.allowance)} ${notice.period === "day" ? "daily" : "monthly"} allowance`;
}

export function UsageNoticeOverlay({
  notices,
  onOpenBilling,
  onDismiss,
}: {
  notices?: readonly UsageNotice[];
  onOpenBilling?: (url: string) => void;
  onDismiss?: (notice: UsageNotice) => void;
}) {
  const [dismissed, setDismissed] = useState(() => [
    ...new Set([
      ...cardDismissals,
      ...dismissedUsageNoticeKeys(widgetStateHost()?.widgetState),
    ]),
  ]);
  useEffect(() => {
    const read = () => {
      const saved = dismissedUsageNoticeKeys(widgetStateHost()?.widgetState);
      setDismissed((previous) => [...new Set([...previous, ...saved])]);
    };
    window.addEventListener("openai:set_globals", read);
    read();
    return () => window.removeEventListener("openai:set_globals", read);
  }, []);
  const notice = firstUndismissedUsageNotice(notices, dismissed);
  const [content, setContent] = useState(notice);
  useLayoutEffect(() => {
    if (notice) setContent(notice);
  }, [notice]);
  const visible = Boolean(notice);
  const displayed = notice ?? content;
  const destination = displayed && BILLING_DESTINATIONS[displayed.service];
  function dismiss() {
    if (!notice) return;
    const key = usageNoticeKey(notice);
    if (cardDismissals.has(key)) return;
    cardDismissals.add(key);
    setDismissed((previous) => [...new Set([...previous, key])]);
    // Durable persistence is best effort; research and this dismissal must not
    // wait for the host or backend to acknowledge it.
    try {
      onDismiss?.(notice);
    } catch {
      // Preserve local/widget state when the host cannot save the dismissal.
    }
    const host = widgetStateHost();
    if (host?.setWidgetState) {
      const next = [...dismissed, key].reduce(
        (state, dismissedKey) => withDismissedUsageNotice(state, dismissedKey),
        record(host.widgetState),
      );
      // Other widget state belongs to the host/app. Never replace it with only
      // these dismissals. A persistence failure must not interrupt research.
      try {
        void Promise.resolve(host.setWidgetState(next)).catch(() => {});
      } catch {
        // The current card still remembers the dismissal in memory.
      }
    }
  }
  return (
    <div
      className="usage-notice-layer"
      data-state={visible ? "visible" : "hidden"}
    >
      <div
        className="usage-notice"
        data-state={visible ? "visible" : "hidden"}
        aria-hidden={!visible}
        inert={!visible}
      >
        <Info className="usage-notice-icon" aria-hidden="true" />
        <div className="usage-notice-copy" role="status" aria-atomic="true">
          <strong>{destination?.name} free allowance reached (estimate)</strong>
          {displayed && (
            <span>
              Estimated sourcesQL usage: {usageLabel(displayed)}. Research
              continues while your provider allows it.
            </span>
          )}
        </div>
        <div className="usage-notice-actions">
          {destination && (
            <a
              href={destination.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                if (onOpenBilling) {
                  event.preventDefault();
                  onOpenBilling(destination.href);
                }
              }}
            >
              {destination.name} billing <ExternalLink aria-hidden="true" />
            </a>
          )}
          <Button
            variant="ghost"
            aria-label="Dismiss usage notice"
            onClick={dismiss}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  );
}
