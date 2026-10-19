import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createServer } from "../server/mcp.js";
import { ResearchStore } from "../server/store.js";
import type { ResearchEngine } from "../server/engine.js";
import type { AccessPolicy } from "../server/access.js";
import { snapshotSchema } from "../src/schema.js";
import { decodeResearchView } from "../src/view-wire.js";
import { decodeResearchJobView, researchJobView } from "../src/job-view.js";
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
  jobStatus?: Record<string, unknown>;
  async call<T>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ method, params });
    if (method === "usage_report") return structuredClone(report) as T;
    if (method === "job_status" && this.jobStatus)
      return structuredClone(this.jobStatus) as T;
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

for (const [service, reason] of [
  ["exa", "provider_limit"],
  ["deepseek", "provider_limit"],
  ["deepseek", "operator_limit"],
] as const)
  test(`${service} ${reason} retains the frozen job-card wire while current clients restore optional presentation`, async () => {
    const active = await session({
      mode: "protected",
      principal: "owner-a",
      allowPrivateDisclosure: false,
    });
    // Published widgets validate this old capacity shape strictly. Keep this
    // independent from today's schema so new fields cannot weaken the regression.
    const legacyCapacitySchema = z
      .object({
        resource: z.enum([
          "flight_compute",
          "search_model_budget",
          "hosted_capacity",
        ]),
        reason: z.enum([
          "operator_limit",
          "provider_limit",
          "account_configuration",
        ]),
        period: z.enum(["day", "month", "unknown"]),
        allowance: z.enum(["configured", "included", "unknown"]),
        services: z
          .array(z.enum(["motherduck", "exa", "brave", "serper", "openai"]))
          .max(5)
          .optional(),
        resets_at: z.iso.datetime().optional(),
        limit: z.number().int().nonnegative().optional(),
        used: z.number().int().nonnegative().optional(),
        unit: z.enum(["seconds", "microusd"]).optional(),
      })
      .strict();
    const capacity = {
      resource: "search_model_budget",
      reason,
      period: "unknown",
      allowance: reason === "operator_limit" ? "configured" : "unknown",
      services: [service],
      ...(reason === "provider_limit"
        ? { limit_kind: "credits", http_status: 402, retry_after_seconds: 30 }
        : {}),
    };
    const legacyCapacity = {
      resource: "search_model_budget",
      reason,
      period: "unknown",
      allowance: reason === "operator_limit" ? "configured" : "unknown",
      services: service === "deepseek" ? [] : [service],
    };
    const jobId = "synthetic-provider-refusal";
    active.engine.jobStatus = {
      job_id: jobId,
      request_id: "01010101-0101-4101-8101-010101010101",
      status: "failed",
      pending: false,
      error_code: "provider_unavailable",
      capacity,
    };
    try {
      const opened = await active.client.callTool({
        name: "open_research",
        arguments: { job_id: jobId },
      });
      assert.notEqual(opened.isError, true);
      const wire = opened.structuredContent as Record<string, any>;
      assert.deepEqual(Object.keys(wire).sort(), ["job", "kind"]);
      assert.equal(wire.kind, "research_job_status");
      assert.equal(Object.hasOwn(wire, "usageNotices"), false);
      assert.deepEqual(wire.job.capacity, legacyCapacity);
      assert.deepEqual(
        legacyCapacitySchema.parse(wire.job.capacity),
        legacyCapacity,
      );
      assert.throws(
        () => legacyCapacitySchema.parse(capacity),
        "The frozen schema would reject the new fields if they leaked into structuredContent",
      );
      const meta = opened._meta as Record<string, any>;
      assert.equal(meta.sourcesqlJobPresentationV1.job_id, jobId);
      assert.deepEqual(meta.sourcesqlJobPresentationV1.capacity, capacity);
      assert.deepEqual(meta.sourcesqlJobPresentationV1.usageNotices, [notice]);
      const current = decodeResearchJobView(wire, meta);
      assert.deepEqual(current.job.capacity, capacity);
      assert.deepEqual(current.usageNotices, [notice]);
      assert.deepEqual(
        decodeResearchJobView(wire, {
          sourcesqlJobPresentationV1: {
            ...meta.sourcesqlJobPresentationV1,
            job_id: "other-job",
          },
        }).job.capacity,
        legacyCapacity,
      );
      const status = await active.client.callTool({
        name: "sourcesql_job_status",
        arguments: { job_id: jobId },
      });
      assert.notEqual(status.isError, true);
      const receipt = status.structuredContent as Record<string, any>;
      assert.deepEqual(
        legacyCapacitySchema.parse(receipt.capacity),
        legacyCapacity,
      );
      assert.deepEqual(receipt.provider_capacity_v1, capacity);
      assert.deepEqual(researchJobView(receipt).job.capacity, capacity);
      assert.deepEqual(
        active.engine.calls.map((call) => call.method),
        ["job_status", "usage_notices", "job_status", "usage_notices"],
      );
    } finally {
      await active.close();
    }
  });
