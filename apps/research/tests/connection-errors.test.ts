import { test } from "node:test";
import assert from "node:assert/strict";
import { missingHostTool } from "../src/connection-errors.js";

test("host lookup failures are distinguished from transient and research errors", () => {
  for (const error of [
    new Error('{"detail":"MCP Resource not found"}'),
    new Error('MCP error -32602: Tool "research_status" not found'),
    new Error("Unknown tool: research_status"),
    new Error("MCP error -32601: Method not found"),
  ])
    assert.equal(missingHostTool(error), true);

  for (const error of [
    new Error("Request timed out"),
    new Error("Failed to fetch"),
    new Error("Snapshot not found"),
    new Error("Source page not found"),
    new Error("Research request was cancelled"),
  ])
    assert.equal(missingHostTool(error), false);
});
