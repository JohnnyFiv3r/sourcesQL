import test from "node:test";
import assert from "node:assert/strict";
import {
  createMcpDiagnostic,
  type McpDiagnostic,
} from "../server/mcp-diagnostics.js";

const uri = "ui://sourcesql/research-05a1fb4763622b13.html";

test("widget diagnostics identify resource reads, exact public bytes and stale descriptors", () => {
  const logs: McpDiagnostic[] = [];
  const read = createMcpDiagnostic(
    { id: 1, method: "resources/read", params: { uri } },
    (entry) => logs.push(entry),
  );
  read.response({ id: 1, result: { contents: [{ uri, text: "public UI" }] } });
  read.finish(200, true);
  read.finish(200, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].resource, uri);
  assert.equal(logs[0].resource_returned, true);
  assert.equal(logs[0].resource_bytes, 9);
  assert.match(String(logs[0].resource_sha256), /^[a-f0-9]{64}$/);
  const discovery = createMcpDiagnostic(
    { id: 2, method: "tools/list" },
    (entry) => logs.push(entry),
  );
  discovery.response({
    id: 2,
    result: {
      tools: [{ name: "open_research", _meta: { ui: { resourceUri: uri } } }],
    },
  });
  discovery.finish(200, true);
  assert.equal(logs[1].advertised_resource, uri);
});

test("diagnostics exclude arbitrary method names, URIs, tool arguments, result text and error details", () => {
  const secret = "synthetic-private-token-and-research";
  const logs: McpDiagnostic[] = [];
  for (const request of [
    { method: secret, params: { uri: secret } },
    {
      method: "resources/read",
      params: { uri: `ui://sourcesql/research-${secret}.html` },
    },
    {
      method: "tools/call",
      params: { name: secret, arguments: { sql: secret } },
    },
    {
      method: "tools/call",
      params: { name: "open_research", arguments: { snapshot_id: secret } },
    },
  ]) {
    const trace = createMcpDiagnostic({ ...request, id: secret }, (entry) =>
      logs.push(entry),
    );
    trace.response({
      id: secret,
      result: {
        isError: true,
        content: [{ text: secret }],
        structuredContent: { rows: [secret] },
      },
    });
    trace.response({
      id: secret,
      error: { code: -32602, message: secret, data: secret },
    });
    trace.finish(200, true);
  }
  assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.equal(logs[0].method, "other");
  assert.equal(logs[1].resource, "other");
  assert.equal(logs[2].tool, "other");
  assert.equal(logs[3].tool, "open_research");
  assert.equal(logs[3].rpc_error, -32602);
  assert.equal(logs[3].tool_error, true);
});

test("failed resources, incomplete responses and broken log sinks do not imply successful delivery", () => {
  const logs: McpDiagnostic[] = [];
  const trace = createMcpDiagnostic(
    { id: 1, method: "resources/read", params: { uri } },
    (entry) => logs.push(entry),
  );
  trace.response({ id: 1, error: { code: -32603, message: "not logged" } });
  trace.finish(200, false);
  assert.equal(logs[0].rpc_error, -32603);
  assert.equal(logs[0].resource_returned, undefined);
  assert.equal(logs[0].completed, false);
  const broken = createMcpDiagnostic({}, () => {
    throw new Error("log sink unavailable");
  });
  assert.doesNotThrow(() => broken.finish(401, true));
});

test("malformed methods and unrelated server messages do not disrupt or misclassify requests", () => {
  const logs: McpDiagnostic[] = [];
  const malformed = createMcpDiagnostic(
    { method: { toString: "not callable" } },
    (entry) => logs.push(entry),
  );
  malformed.finish(400, true);
  assert.equal(logs[0].method, "other");
  const trace = createMcpDiagnostic(
    { id: 1, method: "resources/read", params: { uri } },
    (entry) => logs.push(entry),
  );
  trace.response({ id: 2, error: { code: -32603 } });
  trace.response({
    id: 1,
    method: "server/request",
    result: { contents: [{ uri, text: "not the response" }] },
  });
  trace.finish(200, true);
  assert.equal(logs[1].rpc_error, undefined);
  assert.equal(logs[1].resource_returned, undefined);
});
