export const CONNECTION_RECOVERY =
  "Results Demo couldn’t reach a required tool. Refresh tools in ChatGPT’s Results Demo settings, then reopen this table. Saved requests are preserved.";

export function missingHostTool(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /MCP Resource not found|\b(?:unknown|unrecognized) tool\b|\btool\b[^\n]*\bnot found\b|\bmethod not found\b/i.test(
    message,
  );
}
