import { createHash } from "node:crypto";
import type { UsageNotice } from "../src/usage.js";

type Row = Record<string, any>;
type ProviderTotals = {
  service: string;
  requests: number;
  estimated_cost_microusd: number;
  reported_cost_microusd: number;
  reserved_cost_microusd: number;
  reserved_cost_requests: number;
  estimated_cost_requests: number;
  reported_cost_requests: number;
  cost_unavailable_requests: number;
  uncertain_requests: number;
  input_tokens: number;
  output_tokens: number;
};
export type FlightUsage = {
  run_id: string;
  job_id: string;
  started_at: string;
  ended_at: string;
  elapsed_seconds: number;
  instance_type: "F4";
};
export type UsageWindow = { start: string; end: string };
export function usageWindow(params: Row = {}, now = new Date()): UsageWindow {
  const start =
    params.start ??
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString();
  const end =
    params.end ??
    new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();
  if (
    typeof start !== "string" ||
    typeof end !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(start) ||
    !/^\d{4}-\d{2}-\d{2}T/.test(end) ||
    !Number.isFinite(Date.parse(start)) ||
    !Number.isFinite(Date.parse(end)) ||
    Date.parse(end) <= Date.parse(start) ||
    Date.parse(end) - Date.parse(start) > 366 * 86400000
  )
    throw new Error("Choose an ISO date/time interval of at most 366 days");
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}
const integer = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
const providerName = (event: Row) => {
  const name = event.provider ?? event.usage?.provider;
  if (
    event.fixture_only === true ||
    name === "fixture" ||
    event.usage?.cost_basis === "fixture_no_spending"
  )
    return undefined;
  if (
    event.kind === "semantic" ||
    event.kind === "embedding" ||
    name === "pydantic_ai" ||
    name === "openai_embeddings"
  )
    return "openai";
  return ["exa", "brave", "serper", "deepseek"].includes(name)
    ? (name as string)
    : undefined;
};

/** Summarize sanitized receipts. A ceiling or historical reservation is never a cost. */
export function summarizeUsage(
  receipts: Row[],
  flights: FlightUsage[],
  window: UsageWindow,
  host: string,
) {
  const providers = new Map<string, ProviderTotals>();
  const seen = new Set<string>();
  const inWindow = (time: string) =>
    Date.parse(time) >= Date.parse(window.start) &&
    Date.parse(time) < Date.parse(window.end);
  for (const receipt of receipts) {
    if (!inWindow(receipt.started_at)) continue;
    const events = Array.isArray(receipt.events) ? receipt.events : [];
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (!event || typeof event !== "object") continue;
      const service = providerName(event);
      if (
        !service ||
        ["embedding_cache", "cache"].includes(event.kind) ||
        event.status === "not_dispatched"
      )
        continue;
      const key = `${service}:${typeof event.request_id === "string" && event.request_id ? event.request_id : `${receipt.run_id}:${index}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = providers.get(service) ?? {
        service,
        requests: 0,
        estimated_cost_microusd: 0,
        reported_cost_microusd: 0,
        reserved_cost_microusd: 0,
        reserved_cost_requests: 0,
        estimated_cost_requests: 0,
        reported_cost_requests: 0,
        cost_unavailable_requests: 0,
        uncertain_requests: 0,
        input_tokens: 0,
        output_tokens: 0,
      };
      row.requests++;
      const reservation = integer(event.reservation_microusd);
      if (reservation !== undefined) {
        row.reserved_cost_microusd += reservation;
        row.reserved_cost_requests++;
      }
      const usage = event.usage ?? {};
      const reported = integer(usage.cost_microusd),
        estimate = integer(usage.estimated_cost_microusd);
      if (reported !== undefined) {
        row.reported_cost_microusd += reported;
        row.reported_cost_requests++;
      } else if (estimate !== undefined) {
        row.estimated_cost_microusd += estimate;
        row.estimated_cost_requests++;
      } else row.cost_unavailable_requests++;
      if (
        ["reserved", "dispatched", "remote_outcome_unknown"].includes(
          event.status,
        )
      )
        row.uncertain_requests++;
      row.input_tokens += integer(usage.input_tokens) ?? 0;
      row.output_tokens += integer(usage.output_tokens) ?? 0;
      providers.set(service, row);
    }
  }
  const relevant = [
    ...new Map(
      flights.filter((f) => inWindow(f.started_at)).map((f) => [f.run_id, f]),
    ).values(),
  ];
  const seconds = relevant.reduce(
    (sum, f) => sum + Math.ceil(f.elapsed_seconds),
    0,
  );
  const rate =
    host === "pg.eu-central-1-aws.motherduck.com" ? 180_000 : 150_000;
  return {
    kind: "sourcesql_usage_report" as const,
    usage_mode: "provider_managed" as const,
    scope: "sourcesql" as const,
    period: window,
    providers: [...providers.values()]
      .map((row) => ({
        ...row,
        reserved_cost_microusd: row.reserved_cost_requests
          ? row.reserved_cost_microusd
          : null,
        reported_cost_microusd: row.reported_cost_requests
          ? row.reported_cost_microusd
          : null,
        estimated_cost_microusd: row.estimated_cost_requests
          ? row.estimated_cost_microusd
          : null,
      }))
      .sort((a, b) => a.service.localeCompare(b.service)),
    motherduck: {
      observed_flights: relevant.length,
      observed_flight_seconds: seconds,
      estimated_flight_cost_microusd: Math.round((seconds * rate) / 3600),
      estimate_rate_microusd_per_hour: rate,
      rate_reference: "https://motherduck.com/product/pricing/",
      rate_reference_as_of: "2026-10-18",
      sql_compute_cost_microusd: null,
      storage_cost_microusd: null,
      account_billed_cost_microusd: null,
    },
    limitations: [
      "SourcesQL activity only; other applications may consume the same account allowance.",
      "Response costs and Flight runtime pricing are estimates, not invoices or remaining credits.",
      "MotherDuck SQL compute and storage costs are unavailable; Flight wall time is not SQL compute usage.",
      "Operations are attributed to their run start period; failed and cancelled work remains included.",
      "Unreported costs and uncertain requests are not zero-cost requests.",
      "Configured request reservations are reported separately and are not usage charges or invoices.",
    ],
  };
}

export function allowanceNotices(
  month: ReturnType<typeof summarizeUsage>,
  today: ReturnType<typeof summarizeUsage>,
): UsageNotice[] {
  const exa = month.providers.find((row) => row.service === "exa");
  const notices: UsageNotice[] = [];
  const add = (
    service: UsageNotice["service"],
    report: typeof month,
    used: number,
    allowance: number,
    unit: UsageNotice["unit"],
    period: UsageNotice["period"],
  ) => {
    if (used < allowance) return;
    const id = createHash("sha256")
      .update(`${service}:${report.period.start}:${report.period.end}`)
      .digest("hex");
    notices.push({
      id,
      service,
      period,
      period_start: report.period.start,
      period_end: report.period.end,
      used,
      allowance,
      unit,
      basis: "estimated",
      scope: "sourcesql",
      blocking: false,
    });
  };
  add(
    "exa",
    month,
    (exa?.estimated_cost_microusd ?? 0) + (exa?.reported_cost_microusd ?? 0),
    10_000_000,
    "microusd",
    "month",
  );
  add(
    "motherduck",
    today,
    today.motherduck.observed_flight_seconds,
    1800,
    "seconds",
    "day",
  );
  return notices;
}
