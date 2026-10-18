import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import type { ResearchEngine } from "../server/engine.js";
import type { AccessPolicy } from "../server/access.js";
import { snapshotSchema } from "../src/schema.js";
import { decodeResearchView } from "../src/view-wire.js";
import sample from "../fixtures/water-procurement.json";

const seed = snapshotSchema.parse(sample);
const interval = {
  start: "2026-10-01T00:00:00.000Z",
  end: "2026-11-01T00:00:00.000Z",
};
const notice = {
  id: "a".repeat(64),
  service: "exa",
  period: "month",
  period_start: interval.start,
  period_end: interval.end,
  used: 10_007_000,
  allowance: 10_000_000,
  unit: "microusd",
  basis: "estimated",
  scope: "sourcesql",
  blocking: false,
};
const report = {
  kind: "sourcesql_usage_report",
  usage_mode: "provider_managed",
  scope: "sourcesql",
  period: interval,
  providers: [{ service: "exa", requests: 1, estimated_cost_microusd: 7000 }],
  motherduck: { account_billed_cost_microusd: null },
};

class MeterOnlyEngine implements ResearchEngine {
  readonly supportsUsageReporting = true;
  readonly supportsExplain = false;
  calls: { method: string; params: Record<string, unknown> }[] = [];
  notices: unknown = [notice];
  noticeError = false;
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    if (method === "usage_report") return structuredClone(report) as T;
    if (method === "dismiss_usage_notice") return { dismissed: true } as T;
    if (method === "usage_notices") {
      if (this.noticeError) throw new Error("Synthetic metering unavailable");
      return structuredClone(this.notices) as T;
    }
    throw new Error(`Unexpected research dispatch: ${method}`);
  }
}

async function session(access: AccessPolicy) {
  const directory = await mkdtemp(join(tmpdir(), "sourcesql-usage-mcp-"));
  const engine = new MeterOnlyEngine();
  const store = new ResearchStore(directory, seed);
  const server = createServer(
    store,
    join(process.cwd(), "dist/research.html"),
    {
      engine,
      access,
    },
  );
  const client = new Client({ name: "usage-access-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    engine,
    close: async () => {
      await client.close();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("authenticated hosted owner gets reports and notices with private research disclosure disabled", async () => {
  const active = await session({
    mode: "protected",
    principal: "owner-a",
    allowPrivateDisclosure: false,
  });
  try {
    const response = await active.client.callTool({
      name: "sourcesql_usage_report",
      arguments: interval,
    });
    assert.notEqual(response.isError, true);
    assert.deepEqual(response.structuredContent, report);
    const opened = await active.client.callTool({
      name: "open_research",
      arguments: { snapshot_id: seed.id },
    });
    assert.notEqual(opened.isError, true);
    const view = decodeResearchView(opened.structuredContent);
    assert.equal(view.snapshot.id, seed.id);
    assert.deepEqual(view.usageNotices, [notice]);
    assert.deepEqual(active.engine.calls, [
      { method: "usage_report", params: interval },
      { method: "usage_notices", params: {} },
    ]);
  } finally {
    await active.close();
  }
});

test("anonymous fixture clients cannot read owner usage or receive notices", async () => {
  const active = await session({
    mode: "fixture-anonymous",
    principal: "fixture-anonymous",
    allowPrivateDisclosure: false,
  });
  try {
    const response = await active.client.callTool({
      name: "sourcesql_usage_report",
      arguments: interval,
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent, undefined);
    const opened = await active.client.callTool({
      name: "open_research",
      arguments: { snapshot_id: seed.id },
    });
    assert.notEqual(opened.isError, true);
    const view = decodeResearchView(opened.structuredContent);
    assert.equal(view.snapshot.id, seed.id);
    assert.deepEqual(view.usageNotices ?? [], []);
    assert.deepEqual(active.engine.calls, []);
  } finally {
    await active.close();
  }
});

test("unavailable or malformed optional notices do not block the saved table", async () => {
  const active = await session({
    mode: "protected",
    principal: "owner-a",
    allowPrivateDisclosure: false,
  });
  try {
    for (const malformed of [false, true]) {
      active.engine.noticeError = !malformed;
      active.engine.notices = [{ ...notice, used: "malformed" }];
      const opened = await active.client.callTool({
        name: "open_research",
        arguments: { snapshot_id: seed.id },
      });
      assert.notEqual(opened.isError, true);
      const view = decodeResearchView(opened.structuredContent);
      assert.equal(view.snapshot.id, seed.id);
      assert.equal(view.snapshot.rows.length, seed.rows.length);
      assert.deepEqual(view.usageNotices ?? [], []);
    }
    assert.deepEqual(
      active.engine.calls.map((call) => call.method),
      ["usage_notices", "usage_notices"],
    );
  } finally {
    await active.close();
  }
});

test("usage notice dismissal is an app-only idempotent owner action", async () => {
  const active = await session({
    mode: "protected",
    principal: "owner-a",
    allowPrivateDisclosure: false,
  });
  try {
    const { tools } = await active.client.listTools();
    const dismiss = tools.find(
      (tool) => tool.name === "research_dismiss_usage_notice",
    );
    assert.ok(dismiss);
    assert.deepEqual(
      (dismiss._meta?.ui as { visibility: string[] }).visibility,
      ["app"],
    );
    assert.equal(dismiss.annotations?.idempotentHint, true);
    assert.equal(dismiss.annotations?.readOnlyHint, false);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await active.client.callTool({
        name: "research_dismiss_usage_notice",
        arguments: { notice_id: notice.id },
      });
      assert.notEqual(response.isError, true);
      assert.deepEqual(response.structuredContent, { dismissed: true });
    }
    assert.deepEqual(active.engine.calls, [
      { method: "dismiss_usage_notice", params: { notice_id: notice.id } },
      { method: "dismiss_usage_notice", params: { notice_id: notice.id } },
    ]);
  } finally {
    await active.close();
  }
});

test("anonymous clients cannot dismiss owner usage notices", async () => {
  const active = await session({
    mode: "fixture-anonymous",
    principal: "fixture-anonymous",
    allowPrivateDisclosure: false,
  });
  try {
    const response = await active.client.callTool({
      name: "research_dismiss_usage_notice",
      arguments: { notice_id: notice.id },
    });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent, undefined);
    assert.deepEqual(active.engine.calls, []);
  } finally {
    await active.close();
  }
});
