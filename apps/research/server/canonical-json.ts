/** JSON value identity is independent of object-key order; array order remains significant. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}
