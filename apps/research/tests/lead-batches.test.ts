import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  PythonEngine,
  resolveResult,
  resultSnapshot,
} from "../server/engine.js";
import type { EngineResult } from "../server/engine.js";
import { ResearchStore } from "../server/store.js";
import { createServer } from "../server/mcp.js";
import {
  SOURCESQL_LEAD_BATCH_EXAMPLE,
  SOURCESQL_LEAD_FANOUT_GUIDANCE,
  SOURCESQL_SERVER_INSTRUCTIONS,
  leadBatchText,
  leadRecordText,
  type LeadRecordReply,
} from "../server/agent-guidance.js";
import { leadQueueLine } from "../src/presentation.js";
import { snapshotSchema } from "../src/schema.js";
import sample from "../fixtures/water-procurement.json";
import { testEnv } from "./python.js";

type Text = { type: string; text?: string };
const texts = (result: { content?: unknown }) =>
  (result.content as Text[]).map((part) => part.text ?? "");
const textOf = (result: { content?: unknown }) => texts(result).join(" ");

const AURORA = "https://aurora.example/project";
const BIRCH = "https://birch.example/campus";
const MISSING = "https://nowhere.example/x";
const view = (result_id: string) => ({
  result_id,
  view: "leads",
  amendment_revision: null,
});

async function connect(t: { after(callback: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), "sourcesql-lead-batches-"));
  const engine = new PythonEngine(undefined, {
    ...testEnv(),
    SOURCESQL_DATA_DIR: join(dir, "engine"),
    SOURCESQL_PRINCIPAL: "lead-batch-owner",
  });
  const server = createServer(
    new ResearchStore(
      join(dir, "app"),
      snapshotSchema.parse(sample),
      (snapshot) =>
        resolveResult(engine, {
          result_id: snapshot.dataRef!.resultId,
          snapshot_id: snapshot.id,
          title: snapshot.title,
        }),
    ),
    fileURLToPath(new URL("../dist/research.html", import.meta.url)),
    { engine },
  );
  const client = new Client({ name: "lead-batches-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { client, engine };
}

// The SDK's 60 s default is for hosts; the fixture flow does three 40-page fetches and runs
// on loaded shared machines. 240 s sits above the bridge's own 200 s dispatch limit, so the
// engine's named timeout normally reports first, and below the spec's 300 s hang bound.
const FLOW_CALL = { timeout: 240_000 };
type CallParams = Parameters<Client["callTool"]>[0];
async function call(
  client: Client,
  label: string | undefined,
  params: CallParams,
) {
  if (label === undefined) return client.callTool(params);
  try {
    return await client.callTool(params, FLOW_CALL);
  } catch (error) {
    throw new Error(`${label} did not return: ${(error as Error).message}`);
  }
}

type Intake = { lead_set_id: string; result_id: string };
async function intake(
  client: Client,
  urls: string[],
  lead_set_id?: string,
  label?: string,
): Promise<Intake> {
  const result = await call(client, label, {
    name: "add_research_leads",
    arguments: {
      request_id: randomUUID(),
      ...(lead_set_id ? { lead_set_id } : {}),
      leads: urls.map((url, index) => ({
        url,
        title: `Lead ${index}`,
        query: "q",
        rank: index + 1,
      })),
    },
  });
  assert.notEqual(
    result.isError,
    true,
    `${label ?? "intake"}: ${textOf(result)}`,
  );
  return result.structuredContent as unknown as Intake;
}
const batch = (
  client: Client,
  query: string,
  result_id: string,
  label?: string,
) =>
  call(client, label, {
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query,
      inputs: { l: view(result_id) },
    },
  });
const FETCH = "SELECT lead_id, WEB_FETCH(url) AS page FROM input.l";

test("record_lead_batch replies with counts, failure reasons and the ignored sentence", async (t) => {
  const { client } = await connect(t);
  const set = await intake(client, [AURORA, BIRCH, MISSING]);
  const ran = await batch(
    client,
    `SELECT lead_id, WEB_FETCH(url) AS page, WEB_FETCH('https://vendor.example/platform') AS extra FROM input.l`,
    set.result_id,
  );
  const { result_id } = ran.structuredContent as { result_id: string };
  const recorded = await client.callTool({
    name: "record_lead_batch",
    arguments: {
      request_id: randomUUID(),
      lead_set_id: set.lead_set_id,
      batch_result_id: result_id,
    },
  });
  assert.notEqual(recorded.isError, true, textOf(recorded));
  const reply = recorded.structuredContent as unknown as LeadRecordReply;
  assert.equal(
    textOf(recorded),
    `Recorded batch ${result_id} in lead set ${set.lead_set_id}, revision 2, result_id ${reply.result_id}. 2 leads were fetched, 1 failed (1 http_error), 0 were not fetched. 1 fetched page was not a lead in this set and was ignored. The lead set now has 3 leads, 2 fetched, 1 failed, 0 pending. Bind result_id ${reply.result_id} for the next batch and select lead_status = 'pending'. Ask the user before running it.`,
  );
});

test("the record reply writes plurals out and omits the ignored sentence at zero", () => {
  const reply: LeadRecordReply = {
    lead_set_id: "set",
    revision: 4,
    result_id: "wq_new",
    batch_result_id: "wq_batch",
    fetched: 1,
    failed: 3,
    failure_counts: { http_error: 1, unsupported_type: 2 },
    not_fetched: 1,
    ignored: 0,
    totals: { leads: 1, fetched: 1, failed: 3, pending: 0 },
  };
  assert.equal(
    leadRecordText(reply),
    "Recorded batch wq_batch in lead set set, revision 4, result_id wq_new. 1 lead was fetched, 3 failed (2 unsupported_type, 1 http_error), 1 was not fetched. The lead set now has 1 lead, 1 fetched, 3 failed, 0 pending. Bind result_id wq_new for the next batch and select lead_status = 'pending'. Ask the user before running it.",
  );
  assert.match(
    leadRecordText({ ...reply, ignored: 2 }),
    /2 fetched pages were not leads in this set and were ignored\./,
  );
});

test("the record_lead_batch tool entry stays within 1 KB and uses no $ref", async (t) => {
  const { client } = await connect(t);
  const tool = (await client.listTools()).tools.find(
    (entry) => entry.name === "record_lead_batch",
  )!;
  const size = JSON.stringify(tool).length;
  assert.ok(size <= 1024, `tool entry is ${size} characters`);
  assert.ok(!JSON.stringify(tool).includes("$ref"));
});

test("a forged status column is refused by record_lead_batch", async (t) => {
  const { client } = await connect(t);
  const set = await intake(client, [AURORA]);
  const forged = await batch(
    client,
    "SELECT lead_id, 'ok' AS fetch_status FROM input.l",
    set.result_id,
  );
  assert.equal(
    texts(forged).length,
    1,
    "no batch reply when nothing was fetched",
  );
  const refused = await client.callTool({
    name: "record_lead_batch",
    arguments: {
      request_id: randomUUID(),
      lead_set_id: set.lead_set_id,
      batch_result_id: (forged.structuredContent as { result_id: string })
        .result_id,
    },
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /This result fetched no pages/);
});

test("a lead-set batch query reply links rows by lead_id and adds the batch reply", async (t) => {
  const { client } = await connect(t);
  const set = await intake(client, [AURORA, BIRCH, MISSING]);
  const ran = await batch(client, FETCH, set.result_id);
  assert.notEqual(ran.isError, true, textOf(ran));
  const rows = (ran.structuredContent as { rows: { lead_id: string }[] }).rows;
  assert.ok(rows.every((row) => row.lead_id.startsWith("lead_")));
  const [, second] = texts(ran);
  const id = (ran.structuredContent as { result_id: string }).result_id;
  assert.equal(
    second,
    leadBatchText({ fetched: 2, failed: 1, notFetched: 0 }, id),
  );
  assert.match(second, /^Fetched 2 of 3 selected leads\. 1 failed to fetch\./);
  assert.match(second, /record_lead_batch with this result_id/);
  assert.match(second, /ask the user whether to continue/i);
  // A query that read no lead set gets no such block.
  const plain = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: `SELECT url FROM WEB_FETCH('${AURORA}')`,
    },
  });
  assert.equal(texts(plain).length, 1);
});

test("an over-cap lead batch fetches the cap, says how many remain, and can be recorded", async (t) => {
  const { client } = await connect(t);
  const many = Array.from(
    { length: 41 },
    (_, n) => `https://site${n}.example/page`,
  );
  const set = await intake(client, many);
  const ran = await batch(client, FETCH, set.result_id);
  assert.notEqual(ran.isError, true, textOf(ran));
  const [, second] = texts(ran);
  assert.match(
    second,
    /^Fetched 0 of 41 selected leads\. 40 failed to fetch\. 1 was not fetched because this job can fetch at most 40 pages\. Next, call record_lead_batch/,
  );
  assert.match(second, /ask the user whether to continue/i);
  const recorded = await client.callTool({
    name: "record_lead_batch",
    arguments: {
      request_id: randomUUID(),
      lead_set_id: set.lead_set_id,
      batch_result_id: (ran.structuredContent as { result_id: string })
        .result_id,
    },
  });
  assert.notEqual(recorded.isError, true, textOf(recorded));
  assert.match(
    textOf(recorded),
    /40 failed \(40 http_error\), 1 was not fetched\./,
  );
  assert.match(textOf(recorded), /1 pending\./);
  // A query that reads no lead set keeps #111's refusal over the cap.
  const other = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: `SELECT url FROM WEB_FETCH(${many
        .slice(0, 5)
        .map((_, n) => `$u${n}`)
        .join(", ")})`,
      parameters: Object.fromEntries(
        many.slice(0, 5).map((u, n) => [`u${n}`, u]),
      ),
      budgets: { max_fetches: 1 },
    },
  });
  assert.equal(other.isError, true);
});

test("a lower allowance is named in the batch text and an all-skipped batch is not recorded", async (t) => {
  const { client } = await connect(t);
  const set = await intake(client, [AURORA, BIRCH]);
  const run = (max_fetches: number) =>
    client.callTool({
      name: "sourcesql_query",
      arguments: {
        request_id: randomUUID(),
        query: FETCH,
        budgets: { max_fetches },
        inputs: { l: view(set.result_id) },
      },
    });
  const one = await run(1);
  assert.match(
    texts(one)[1],
    /^Fetched 1 of 2 selected leads\. 1 was not fetched because this job can fetch at most 1 page\. Next, call record_lead_batch/,
  );
  const none = await run(0);
  assert.notEqual(none.isError, true, textOf(none));
  assert.equal(
    texts(none)[1],
    "Nothing was fetched: 2 were not fetched because this job can fetch at most 0 pages. There is nothing to record. Ask the user before running another batch.",
  );
});

test("the guidance tells agents to order and limit before the fetch", () => {
  assert.match(
    SOURCESQL_LEAD_FANOUT_GUIDANCE,
    /Put ORDER BY and LIMIT 40 in a CTE before WEB_FETCH/,
  );
});

test("the batch text separates fetched from failed attempts", () => {
  assert.match(
    leadBatchText({ fetched: 0, failed: 1, notFetched: 0 }, "wq_x"),
    /^Fetched 0 of 1 selected lead\. 1 failed to fetch\. Next, call record_lead_batch with this result_id, wq_x,/,
  );
  assert.match(
    leadBatchText({ fetched: 37, failed: 0, notFetched: 0 }, "wq_x"),
    /^Fetched 37 of 37 selected leads\. Next,/,
  );
});

test("a lead set cannot be corrected, so the queue and the table agree", async (t) => {
  const { client } = await connect(t);
  const set = await intake(client, [AURORA, MISSING]);
  const ran = await batch(client, FETCH, set.result_id);
  const recorded = await client.callTool({
    name: "record_lead_batch",
    arguments: {
      request_id: randomUUID(),
      lead_set_id: set.lead_set_id,
      batch_result_id: (ran.structuredContent as { result_id: string })
        .result_id,
    },
  });
  const { result_id } = recorded.structuredContent as { result_id: string };
  const opened = await client.callTool({
    name: "open_research",
    arguments: {
      result_ref: { result_id, snapshot_id: "leads-1", title: "Leads" },
    },
  });
  const view = opened.structuredContent as {
    revision: number;
    snapshot: { rows: { id: string; values: { lead_status: string } }[] };
  };
  const failed = view.snapshot.rows.find(
    (r) => r.values.lead_status === "failed",
  )!;
  const amended = await client.callTool({
    name: "amend_observation",
    arguments: {
      snapshot_id: "leads-1",
      row_id: failed.id,
      field: "lead_status",
      value: "fetched",
      expected_revision: view.revision,
      mutation_id: randomUUID(),
    },
  });
  assert.equal(amended.isError, true);
  assert.match(
    textOf(amended),
    /A lead set records fetch outcomes itself and cannot be corrected/,
  );
});

test("read_result and open_research of a lead set start with the queue line", async (t) => {
  const { client, engine } = await connect(t);
  const set = await intake(client, [AURORA, MISSING]);
  const ran = await batch(client, FETCH, set.result_id);
  const recorded = await client.callTool({
    name: "record_lead_batch",
    arguments: {
      request_id: randomUUID(),
      lead_set_id: set.lead_set_id,
      batch_result_id: (ran.structuredContent as { result_id: string })
        .result_id,
    },
  });
  const { result_id } = recorded.structuredContent as { result_id: string };
  const line = `Lead set ${set.lead_set_id}, revision 2: 2 leads, 1 fetched, 1 failed, 0 pending.`;
  const read = await client.callTool({
    name: "sourcesql_read_result",
    arguments: { result_id },
  });
  assert.equal(texts(read)[0], line);
  const page = await engine.call<EngineResult>("read_result", { result_id });
  assert.equal(
    resultSnapshot(page, { result_id, snapshot_id: "lead-set", title: "Leads" })
      .leadSet?.totals.fetched,
    1,
  );
  const opened = await client.callTool({
    name: "open_research",
    arguments: {
      result_ref: { result_id, snapshot_id: "lead-set", title: "Leads" },
    },
  });
  assert.notEqual(opened.isError, true, textOf(opened));
  assert.equal(texts(opened)[0].split("\n")[0], line);
  // A result that is not a lead set has no queue line.
  const plain = await client.callTool({
    name: "sourcesql_query",
    arguments: { request_id: randomUUID(), query: "SELECT 1 AS n" },
  });
  const { result_id: plainId } = plain.structuredContent as {
    result_id: string;
  };
  const plainRead = await client.callTool({
    name: "sourcesql_read_result",
    arguments: { result_id: plainId },
  });
  assert.ok(!texts(plainRead)[0].startsWith("Lead set"));
  assert.equal(
    leadQueueLine({
      leadSetId: "s",
      revision: 1,
      totals: { leads: 1, fetched: 0, failed: 0, pending: 1 },
    }),
    "Lead set s, revision 1: 1 lead, 0 fetched, 0 failed, 1 pending.",
  );
});

test("served instructions carry the lead fan-out guidance and example", async (t) => {
  const { client } = await connect(t);
  const instructions = client.getInstructions()!;
  assert.ok(instructions.includes(SOURCESQL_LEAD_FANOUT_GUIDANCE));
  assert.ok(instructions.includes(SOURCESQL_LEAD_BATCH_EXAMPLE));
  assert.ok(
    SOURCESQL_SERVER_INSTRUCTIONS.includes(SOURCESQL_LEAD_FANOUT_GUIDANCE),
  );
  assert.match(instructions, /ask whether to continue/);
  assert.match(instructions, /Do not split a job/);
  assert.match(
    instructions,
    /^[\s\S]*If sourcesql_capabilities reports host_search_route.available, for a large search/m,
  );
});

test("MCP fixture flow: intake, three batches, three records, final cited table", async (t) => {
  const { client } = await connect(t);
  const known = [AURORA, BIRCH, "https://vendor.example/platform"];
  const filler = (from: number, to: number) =>
    Array.from(
      { length: to - from },
      (_, n) => `https://site${from + n}.example/page`,
    );
  const first = await intake(
    client,
    [...known, ...filler(0, 147)],
    undefined,
    "intake 1",
  );
  const second = await intake(
    client,
    filler(500, 650),
    first.lead_set_id,
    "intake 2",
  );
  let head = second.result_id;
  let totals = { leads: 0, fetched: 0, failed: 0, pending: 0 };
  for (let n = 0; n < 3; n++) {
    const ran = await batch(
      client,
      `WITH batch AS (SELECT lead_id, url FROM input.l WHERE lead_status = 'pending' ORDER BY url LIMIT 40) SELECT lead_id, WEB_FETCH(url) AS page FROM batch`,
      head,
      `batch ${n + 1} query`,
    );
    assert.notEqual(ran.isError, true, `batch ${n + 1} query: ${textOf(ran)}`);
    const recorded = await call(client, `batch ${n + 1} record`, {
      name: "record_lead_batch",
      arguments: {
        request_id: randomUUID(),
        lead_set_id: first.lead_set_id,
        batch_result_id: (ran.structuredContent as { result_id: string })
          .result_id,
      },
    });
    assert.notEqual(
      recorded.isError,
      true,
      `batch ${n + 1} record: ${textOf(recorded)}`,
    );
    const reply = recorded.structuredContent as unknown as LeadRecordReply;
    head = reply.result_id;
    totals = reply.totals;
  }
  assert.equal(totals.leads, 300);
  assert.equal(totals.fetched + totals.failed, 120);
  assert.equal(totals.pending, 180);
});

test("the shipped example SQL runs over a lead set and its batch can be recorded", async (t) => {
  const { client } = await connect(t);
  const set = await intake(client, [AURORA, BIRCH, MISSING]);
  const ran = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: SOURCESQL_LEAD_BATCH_EXAMPLE,
      inputs: { leads: view(set.result_id) },
    },
  });
  assert.notEqual(ran.isError, true, textOf(ran));
  const recorded = await client.callTool({
    name: "record_lead_batch",
    arguments: {
      request_id: randomUUID(),
      lead_set_id: set.lead_set_id,
      batch_result_id: (ran.structuredContent as { result_id: string })
        .result_id,
    },
  });
  assert.notEqual(recorded.isError, true, textOf(recorded));
});

test("an unused lead pin gets no batch reply, and a CTE batch over the same pin does", async (t) => {
  const { client } = await connect(t);
  const set = await intake(client, [AURORA, BIRCH]);
  const unused = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: `SELECT url, fetch_status FROM WEB_FETCH('${AURORA}')`,
      inputs: { unused: view(set.result_id) },
    },
  });
  assert.notEqual(unused.isError, true, textOf(unused));
  assert.equal(texts(unused).length, 1);
  assert.equal(
    (unused.structuredContent as { lead_inputs_read?: unknown })
      .lead_inputs_read,
    undefined,
  );
  const refused = await client.callTool({
    name: "record_lead_batch",
    arguments: {
      request_id: randomUUID(),
      lead_set_id: set.lead_set_id,
      batch_result_id: (unused.structuredContent as { result_id: string })
        .result_id,
    },
  });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /did not read this lead set/);
  const cte = await batch(
    client,
    "WITH b AS (SELECT lead_id, url FROM input.l ORDER BY host_rank LIMIT 40) SELECT lead_id, WEB_FETCH(url) AS page FROM b",
    set.result_id,
  );
  assert.equal(texts(cte).length, 2);
});

test("a lead batch with its own ORDER BY is refused with the CTE instruction", async (t) => {
  const { client } = await connect(t);
  const set = await intake(client, [AURORA, BIRCH]);
  const refused = await batch(
    client,
    "SELECT host_rank, lead_id, WEB_FETCH(url) AS page FROM input.l ORDER BY host_rank LIMIT 41",
    set.result_id,
  );
  assert.equal(refused.isError, true);
  assert.equal(
    textOf(refused),
    "invalid_query: In a lead batch, put ORDER BY and LIMIT in a CTE before WEB_FETCH. An ORDER BY or LIMIT in the same SELECT as WEB_FETCH does not choose which pages are fetched.",
  );
});

test("a table is badged as lead-derived only when its SQL read the lead set", async (t) => {
  const { client } = await connect(t);
  const set = await intake(client, [AURORA]);
  const open = async (result: { structuredContent?: unknown }, id: string) => {
    const { result_id } = result.structuredContent as { result_id: string };
    const opened = await client.callTool({
      name: "open_research",
      arguments: { result_ref: { result_id, snapshot_id: id, title: id } },
    });
    assert.notEqual(opened.isError, true, textOf(opened));
    return (opened.structuredContent as { snapshot: { leadDerived?: boolean } })
      .snapshot;
  };
  const unused = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: `SELECT url, fetch_status FROM WEB_FETCH('${AURORA}')`,
      inputs: { unused: view(set.result_id) },
    },
  });
  assert.equal((await open(unused, "unused-pin")).leadDerived, undefined);
  const read = await batch(
    client,
    "WITH b AS (SELECT lead_id, url FROM input.l LIMIT 5) SELECT lead_id, WEB_FETCH(url)[1].fetch_status AS status FROM b",
    set.result_id,
  );
  assert.equal((await open(read, "read-set")).leadDerived, true);
  // The mark survives ordinary reuse of a table made from a lead set.
  const titles = await batch(
    client,
    "SELECT title FROM input.l",
    set.result_id,
  );
  assert.equal((await open(titles, "titles")).leadDerived, true);
  const { result_id } = titles.structuredContent as { result_id: string };
  const reused = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: "SELECT title FROM input.intermediate",
      inputs: {
        intermediate: {
          result_id,
          view: "original",
          amendment_revision: null,
        },
      },
    },
  });
  assert.equal((await open(reused, "reused")).leadDerived, true);
  // An effective-view pin is materialized by the app first; the mark survives that too.
  const effective = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: "SELECT title FROM input.saved",
      inputs: {
        saved: { result_id, view: "effective", amendment_revision: 0 },
      },
    },
  });
  assert.notEqual(effective.isError, true, textOf(effective));
  assert.equal((await open(effective, "effective")).leadDerived, true);
  assert.equal(
    (effective.structuredContent as { lead_inputs_read?: unknown })
      .lead_inputs_read,
    undefined,
    "reuse is not a read of the lead set",
  );
  // Reuse of a table that never touched a lead set stays unmarked.
  const plain = await client.callTool({
    name: "sourcesql_query",
    arguments: { request_id: randomUUID(), query: "SELECT 1 AS n" },
  });
  const again = await client.callTool({
    name: "sourcesql_query",
    arguments: {
      request_id: randomUUID(),
      query: "SELECT n FROM input.p",
      inputs: {
        p: {
          result_id: (plain.structuredContent as { result_id: string })
            .result_id,
          view: "original",
          amendment_revision: null,
        },
      },
    },
  });
  assert.equal((await open(again, "plain-reuse")).leadDerived, undefined);
});
