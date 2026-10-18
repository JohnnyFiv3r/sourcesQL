import { createHash } from "node:crypto";

const methods = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Only public bundle identifiers can enter logs. Unknown paths and arbitrary
// client-supplied strings must never become diagnostic output.
function resource(value: unknown): string {
  return typeof value === "string" &&
    (/^ui:\/\/(?:sourcesql|research-legacy|open-webql)\/research-[a-f0-9]{16}\.html$/.test(
      value,
    ) ||
      value === "ui://research-legacy/research.html")
    ? value
    : "other";
}

export type McpDiagnostic = Record<string, string | number | boolean>;

export function createMcpDiagnostic(
  body: unknown,
  emit: (entry: McpDiagnostic) => void,
) {
  const request = record(body);
  const params = record(request.params);
  const method =
    typeof request.method === "string" && methods.has(request.method)
      ? request.method
      : "other";
  const fields: McpDiagnostic = {
    event: "sourcesql.mcp_request",
    method,
    ...(method === "tools/call"
      ? { tool: params.name === "open_research" ? "open_research" : "other" }
      : {}),
    ...(method === "resources/read" ? { resource: resource(params.uri) } : {}),
  };
  const started = performance.now();
  let finished = false;
  return {
    response(message: unknown) {
      const response = record(message);
      if (
        Object.hasOwn(response, "method") ||
        !Object.hasOwn(response, "id") ||
        response.id !== request.id
      )
        return;
      const error = record(response.error);
      if (Number.isSafeInteger(error.code)) {
        fields.rpc_error = Number(error.code);
        return;
      }
      const result = record(response.result);
      if (typeof result.isError === "boolean")
        fields.tool_error = result.isError;
      if (method === "tools/list" && Array.isArray(result.tools)) {
        const renderer = result.tools
          .map(record)
          .find((t) => t.name === "open_research");
        fields.advertised_resource = resource(
          record(record(renderer?._meta).ui).resourceUri,
        );
      }
      if (method === "resources/read" && Array.isArray(result.contents)) {
        const contents = result.contents.map(record);
        const bundle = contents.find(
          (entry) =>
            resource(entry.uri) !== "other" &&
            entry.uri === params.uri &&
            typeof entry.text === "string",
        );
        fields.resource_returned = Boolean(bundle);
        if (bundle) {
          fields.resource_bytes = Buffer.byteLength(bundle.text as string);
          fields.resource_sha256 = createHash("sha256")
            .update(bundle.text as string)
            .digest("hex");
        }
      }
    },
    finish(status: number, completed: boolean) {
      if (finished) return;
      finished = true;
      try {
        emit({
          ...fields,
          http_status: status,
          completed,
          elapsed_ms: Math.round(performance.now() - started),
        });
      } catch {
        // Optional diagnostics must not change request behavior.
      }
    },
  };
}
