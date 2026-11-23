import {
  snapshotAssertion,
  sourcesForSelection,
  type Snapshot,
} from "./schema.js";

export const HOST_ASSERTED_LABEL = "Host-asserted";
export const HOST_ASSERTED_TITLE =
  "Host-asserted: the agent that saved this research supplied this source. sourcesQL has not fetched or checked it.";
export { snapshotAssertion, type Assertion } from "./schema.js";
export const HOST_ASSERTED_NOTICE =
  'Sources and quotes in a snapshot marked assertion "host" were supplied by the agent that saved it: sourcesQL has not fetched or checked them.';
export const HOST_EVIDENCE_REASON =
  "the evidence does not match any source text sourcesQL retained.";
export const hostSourceText = (url: string) => `${url} (host-asserted)`;
export const hostQuoteText = (quote: string) =>
  `"${quote}" (host-asserted, not checked against fetched text)`;

export function nextTableSort(
  current: { field: string; ascending: boolean } | undefined,
  field: string,
): { field: string; ascending: boolean } | undefined {
  if (current?.field !== field) return { field, ascending: true };
  return current.ascending ? { field, ascending: false } : undefined;
}

/** Opening a selected URL is navigation, not an attribution of other cell values. */
export function sourceLinksForValue(
  sources: { url: string; label?: string }[],
  value: unknown,
): { url: string; label?: string }[] {
  if (sources.length || typeof value !== "string") return sources;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      ? [{ url: value, label: "Selected URL" }]
      : [];
  } catch {
    return [];
  }
}

const acronym = new Map([
  ["id", "ID"],
  ["url", "URL"],
  ["api", "API"],
  ["sql", "SQL"],
  ["mcp", "MCP"],
  ["rfp", "RFP"],
  ["rfq", "RFQ"],
  ["epa", "EPA"],
  ["us", "US"],
  ["usa", "USA"],
  ["tn", "TN"],
  ["utc", "UTC"],
]);
const units = new Map([
  ["mw", "MW"],
  ["kw", "kW"],
  ["gw", "GW"],
  ["mwh", "MWh"],
  ["kwh", "kWh"],
  ["gwh", "GWh"],
  ["usd", "USD"],
  ["pct", "%"],
  ["percent", "%"],
  ["mgd", "MGD"],
]);

/** Human-readable decoration; canonical column keys and values never change. */
export function humanizeColumnLabel(key: string, label = key): string {
  if (label !== key && /[A-Z\s()]/.test(label)) return label;
  const raw = label || key;
  if (raw === "planned_mw") return "Planned Capacity (MW)";
  if (raw === "url" || raw === "source_url") return "Source";
  const words = raw.split("_").filter(Boolean);
  const unit =
    words.length > 1 ? units.get(words.at(-1)!.toLowerCase()) : undefined;
  if (unit) words.pop();
  const title = words
    .map(
      (word) =>
        acronym.get(word.toLowerCase()) ??
        word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
  return unit ? `${title} (${unit})` : title;
}

function sourceColumn(key: string) {
  return /^(?:urls?|website|websites|links?)$|_(?:urls?|links?)$/.test(
    key.toLowerCase(),
  );
}

/** Move the human identity first and source metadata last; preserve other order. */
export function presentationColumns(snapshot: Snapshot) {
  const columns = snapshot.columns.map((column) => ({
    ...column,
    label: humanizeColumnLabel(column.key, column.label),
  }));
  const primary =
    columns.find((column) =>
      /^(?:name|entity_name|project|project_name|utility_name|company_name|organization_name|facility_name|title|document_title)$/.test(
        column.key.toLowerCase(),
      ),
    ) ?? columns.find((column) => /_name$/.test(column.key.toLowerCase()));
  return [
    ...(primary ? [primary] : []),
    ...columns.filter(
      (column) => column !== primary && !sourceColumn(column.key),
    ),
    ...columns.filter(
      (column) => column !== primary && sourceColumn(column.key),
    ),
  ];
}

/** A compact display address; the original URL remains the link destination. */
export function formatSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return value;
    let path = url.pathname.replace(/\/$/, "");
    try {
      path = decodeURIComponent(path);
    } catch {
      /* Keep the encoded path. */
    }
    const lastSegment = path.split("/").filter(Boolean).at(-1);
    if (path.length > 32 && lastSegment) path = "/…/" + lastSegment;
    return url.hostname.replace(/^www\./, "") + path;
  } catch {
    return value;
  }
}

/** One sentence for agent text: how many sources a host-asserted snapshot supplies. */
export function hostAssertedSummary(snapshot: Snapshot): string {
  if (snapshotAssertion(snapshot) !== "host") return "";
  const urls = new Set<string>();
  let rows = 0;
  for (const row of snapshot.rows) {
    const sources = sourcesForSelection(row);
    if (!sources.length) continue;
    rows++;
    for (const source of sources) urls.add(source.url);
  }
  return urls.size
    ? `${urls.size} sources on ${rows} rows are host-asserted: sourcesQL has not fetched or checked them.`
    : "";
}
