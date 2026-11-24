import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LeadColumnLabel,
  LeadSetBanner,
  LeadSetEmpty,
  leadFetchFailure,
} from "../src/lead-set.js";
import {
  HOST_ASSERTED_LABEL,
  HOST_ASSERTED_TITLE,
  LEAD_HOST_COLUMNS,
  LEAD_SET_EMPTY,
  LEAD_SET_NOTE,
  hostAssertedColumn,
  leadQueueLine,
  markLeadSources,
  needsSourcePicker,
} from "../src/presentation.js";
import { SourceList } from "../src/source-list.js";
import type { Snapshot } from "../src/schema.js";

const leadSet = {
  leadSetId: "7d0c2c1e-6a38-4f3c-9d77-2f4b0d4a6f10",
  revision: 4,
  totals: { leads: 412, fetched: 117, failed: 9, pending: 286 },
};

const leadSnapshot = { leadSet } as unknown as Snapshot;
const derived = (rows: unknown[]) =>
  ({
    dataClassification: "host_reported",
    readsLeadSet: true,
    rows,
  }) as unknown as Snapshot;

test("a table built from a lead set labels the columns no cell cites a source for", () => {
  const snapshot = derived([
    {
      id: "r1",
      values: {
        title: "Known",
        campus: "Aurora Campus",
        lead_status: "fetched",
      },
      evidence: {
        campus: ["Aurora Campus is a fictional planned data-center project."],
      },
      cellSources: { campus: [{ url: "https://aurora.example/project" }] },
    },
  ]);
  assert.equal(hostAssertedColumn(snapshot, "title"), true);
  assert.equal(hostAssertedColumn(snapshot, "campus"), false);
  assert.equal(hostAssertedColumn(snapshot, "lead_status"), false);
  // A host_reported table whose SQL never read the lead set (an unused pin) has no badges.
  const unused = {
    ...snapshot,
    readsLeadSet: undefined,
  } as unknown as Snapshot;
  assert.equal(hostAssertedColumn(unused, "title"), false);
  assert.equal(hostAssertedColumn(unused, "fetch_status"), false);
  assert.equal(
    hostAssertedColumn(
      { dataClassification: "public_web", rows: [] } as unknown as Snapshot,
      "title",
    ),
    false,
  );
  const html = renderToStaticMarkup(
    createElement(LeadColumnLabel, { snapshot, field: "title" }),
  );
  assert.ok(html.includes(`>${HOST_ASSERTED_LABEL}</span>`));
});

test("host-asserted columns carry the label and engine-recorded columns do not", () => {
  for (const field of LEAD_HOST_COLUMNS) {
    const html = renderToStaticMarkup(
      createElement(LeadColumnLabel, { snapshot: leadSnapshot, field }),
    );
    assert.ok(html.includes(`>${HOST_ASSERTED_LABEL}</span>`), field);
    assert.ok(html.includes(`title="${HOST_ASSERTED_TITLE}"`), field);
  }
  for (const field of [
    "lead_status",
    "fetch_failure",
    "batch_result_id",
    "lead_id",
    "url",
  ])
    assert.equal(
      renderToStaticMarkup(
        createElement(LeadColumnLabel, { snapshot: leadSnapshot, field }),
      ),
      "",
      field,
    );
});

test("the lead-set banner shows the queue line and the note", () => {
  const html = renderToStaticMarkup(
    createElement(LeadSetBanner, {
      leadSet,
      queueLine: leadQueueLine(leadSet),
    }),
  );
  assert.equal(
    leadQueueLine(leadSet),
    `Lead set ${leadSet.leadSetId}, revision 4: 412 leads, 117 fetched, 9 failed, 286 pending.`,
  );
  assert.ok(html.includes(leadQueueLine(leadSet)));
  assert.ok(html.includes(LEAD_SET_NOTE));
  assert.match(html, /aria-label="Dismiss note"/);
});

test("the queue line writes one lead in the singular", () => {
  assert.match(
    leadQueueLine({
      ...leadSet,
      totals: { leads: 1, fetched: 0, failed: 0, pending: 1 },
    }),
    /: 1 lead, 0 fetched/,
  );
});

test("a failed lead's reason is available and a fetched or pending lead has none", () => {
  assert.equal(
    leadFetchFailure({ lead_status: "failed", fetch_failure: "http_error" }),
    "http_error",
  );
  assert.equal(
    leadFetchFailure({ lead_status: "fetched", fetch_failure: null }),
    undefined,
  );
  assert.equal(
    leadFetchFailure({ lead_status: "pending", fetch_failure: null }),
    undefined,
  );
  assert.equal(
    leadFetchFailure({ lead_status: "failed", fetch_failure: "" }),
    undefined,
  );
});

test("an empty lead set says how to fill it", () => {
  assert.ok(
    renderToStaticMarkup(createElement(LeadSetEmpty)).includes(LEAD_SET_EMPTY),
  );
});

test("every URL in a lead-set table goes through the labelled source picker", () => {
  const plain = [{ url: "https://aurora.example/project" }];
  assert.deepEqual(markLeadSources(plain, undefined), plain);
  const marked = markLeadSources(plain, leadSet);
  assert.deepEqual(marked, [{ url: plain[0].url, assertion: "host" }]);
  assert.equal(needsSourcePicker(marked), true);
  const html = renderToStaticMarkup(
    createElement(SourceList, {
      sources: marked,
      busy: false,
      onVisit: () => {},
    }),
  );
  assert.match(html, new RegExp(`<small[^>]*>${HOST_ASSERTED_LABEL}</small>`));
  assert.equal(needsSourcePicker(plain), false);
});
