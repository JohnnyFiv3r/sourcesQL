import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock,
  ExternalLink,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";
import { Button } from "./ui.js";
import type { ResearchCapacity, ResearchJobView } from "./job-view.js";

export type ResearchJobStatusPanelProps = {
  view: ResearchJobView;
  busy: boolean;
  error?: string;
  onCheck(): void;
  onResume(): void;
  onOpenResult?(): void;
  onOpenBilling?(url: string): void;
};

type CapacityService = NonNullable<ResearchCapacity["services"]>[number];
// Verified provider-owned billing destinations. Job receipts select services, never URLs.
const BILLING_DESTINATIONS = {
  motherduck: {
    label: "MotherDuck billing",
    href: "https://app.motherduck.com/settings/billing",
  },
  exa: { label: "Exa billing", href: "https://dashboard.exa.ai/billing" },
  brave: {
    label: "Brave billing",
    href: "https://api-dashboard.search.brave.com/app/settings/billing?tab=payment-method",
  },
  serper: { label: "Serper billing", href: "https://serper.dev/billing" },
  openai: {
    label: "OpenAI API billing",
    href: "https://platform.openai.com/account/billing/overview",
  },
} as const satisfies Record<CapacityService, { label: string; href: string }>;

function capacityMessage(capacity: ResearchCapacity) {
  if (capacity.reason === "account_configuration")
    return {
      title: "Hosted research needs account setup",
      description:
        "Your job is saved. Check the hosting account configuration before resuming it.",
    };
  const included =
    capacity.allowance === "included" && capacity.reason === "provider_limit";
  const period =
    capacity.period === "day"
      ? " for today"
      : capacity.period === "month"
        ? " for this month"
        : "";
  const authority =
    capacity.reason === "operator_limit" || capacity.allowance === "configured"
      ? "This is a configured application limit. "
      : !included
        ? "The hosting provider reported a capacity limit. "
        : "";
  return {
    title: `${included ? "Free hosted capacity" : "Research capacity"} is used up${period}`,
    description: `${authority}Your job is saved. Resume it after capacity becomes available.`,
  };
}
function jobMessage(view: ResearchJobView) {
  const job = view.job;
  // Reconcile uncertain submissions before any capacity or retry action.
  if (job.status === "submission_unknown")
    return {
      title: "Awaiting submission confirmation",
      description:
        "Submission has not been confirmed. Your saved job may already be running. Check its status; do not submit it again.",
    };
  if (job.status === "completed")
    return {
      title: "Research step completed",
      description: job.result_id
        ? "This job’s result is saved and ready to open. Further research steps may remain."
        : "The completed job record is saved.",
    };
  if (job.capacity && job.status === "queued")
    return capacityMessage(job.capacity);
  switch (job.status) {
    case "queued":
      return {
        title: "Research is queued",
        description:
          "Your job is saved. Choose Resume research when you are ready; it will not start automatically.",
      };
    case "dispatching":
      return {
        title: "Starting research",
        description:
          "Your saved job is being submitted. Check its status before taking another action.",
      };
    case "running":
      return {
        title: "Research is running",
        description:
          "Your saved job is running. Checking its status does not start new research.",
      };
    case "failed":
      return {
        title: "Research did not complete",
        description:
          "The saved job record is retained. Check its status for the next available action.",
      };
    case "cancelled":
      return {
        title: "Research was cancelled",
        description: "The cancelled job record is retained.",
      };
  }
}
function capacityUsage(capacity: ResearchCapacity) {
  if (!capacity.unit) return;
  const format = (value: number) => {
    if (capacity.unit === "microusd")
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(value / 1_000_000);
    if (value >= 60 && value % 60 === 0)
      return `${new Intl.NumberFormat().format(value / 60)} ${value === 60 ? "minute" : "minutes"}`;
    return `${new Intl.NumberFormat().format(value)} ${value === 1 ? "second" : "seconds"}`;
  };
  const reserved = capacity.allowance === "configured";
  if (capacity.used !== undefined && capacity.limit !== undefined)
    return `${format(capacity.used)} of ${format(capacity.limit)} ${reserved ? "reserved" : "used"}`;
  if (capacity.limit !== undefined) return `Limit: ${format(capacity.limit)}`;
  if (capacity.used !== undefined)
    return `${reserved ? "Reserved" : "Used"}: ${format(capacity.used)}`;
}

export function ResearchJobStatusPanel({
  view,
  busy,
  error,
  onCheck,
  onResume,
  onOpenResult,
  onOpenBilling,
}: ResearchJobStatusPanelProps) {
  const { job } = view;
  const message = jobMessage(view);
  const uncertain = job.status === "submission_unknown";
  const active = job.status === "running" || job.status === "dispatching";
  const completed = job.status === "completed";
  const resumeDisabled =
    busy || !job.can_resume || Boolean(job.capacity) || job.status !== "queued";
  const canOpen = completed && Boolean(job.result_id) && Boolean(onOpenResult);
  const StatusIcon = uncertain
    ? CircleAlert
    : completed
      ? Check
      : active
        ? LoaderCircle
        : job.capacity
          ? Pause
          : Clock;
  const reset = job.capacity?.resets_at
    ? new Date(job.capacity.resets_at)
    : undefined;
  const resetLabel =
    reset && Number.isFinite(reset.getTime())
      ? new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(reset)
      : undefined;
  const usage = job.capacity && capacityUsage(job.capacity);
  const billing =
    job.status === "queued" && job.capacity
      ? [...new Set(job.capacity.services ?? [])]
          .filter((service) => Object.hasOwn(BILLING_DESTINATIONS, service))
          .map((service) => BILLING_DESTINATIONS[service])
      : [];
  return (
    <section className="job-status-panel" aria-label="Research job">
      <div
        className="job-status-announcement"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="job-status-icon" aria-hidden="true">
          <StatusIcon size={19} />
        </span>
        <div className="job-status-copy">
          <h2 className="job-status-title">{message.title}</h2>
          <p className="job-status-description">{message.description}</p>
          {usage && <p className="job-status-usage">{usage}</p>}
          {resetLabel && (
            <p className="job-status-reset">
              Capacity resets{" "}
              <time dateTime={job.capacity!.resets_at}>{resetLabel}</time>
            </p>
          )}
        </div>
      </div>
      {billing.length > 0 && (
        <div className="job-status-billing">
          <p className="job-status-billing-note">
            Upgrades or adding a card are optional. Configured app limits may
            still need adjustment. Billing changes do not resume this job.
          </p>
          <nav
            className="job-status-billing-links"
            aria-label="Provider billing"
          >
            {billing.map((destination) => (
              <a
                key={destination.href}
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
                {destination.label}
                <ExternalLink size={12} aria-hidden="true" />
              </a>
            ))}
          </nav>
        </div>
      )}
      {error && (
        <p className="job-status-error" role="alert">
          {error}
        </p>
      )}
      <div
        className="job-status-actions"
        role="group"
        aria-label="Research job actions"
      >
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            if (!busy) onCheck();
          }}
        >
          <RefreshCw aria-hidden="true" /> Check status
        </Button>
        {!completed && (
          <Button
            variant="primary"
            disabled={resumeDisabled}
            onClick={() => {
              if (!resumeDisabled) onResume();
            }}
          >
            <Play aria-hidden="true" /> Resume research
          </Button>
        )}
        {canOpen && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              if (!busy && canOpen) onOpenResult?.();
            }}
          >
            Open saved result <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </section>
  );
}
