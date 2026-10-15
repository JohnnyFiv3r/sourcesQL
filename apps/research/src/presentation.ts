import type { Snapshot } from "./schema.js";

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
