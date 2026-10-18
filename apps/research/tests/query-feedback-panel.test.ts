import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryFeedbackPanel } from "../src/query-feedback-panel.js";
import type { QueryFeedback } from "../src/query-feedback.js";

function feedback(): QueryFeedback {
  return {
    schema_version: 1,
    advisory: true,
    query_sha256: "a".repeat(64),
    parameters_sha256: "b".repeat(64),
    input_pins_sha256: "c".repeat(64),
    description_status: "available",
    description: {
      summary: "Return up to 24 source documents, deduplicated by URL.",
      steps: [
        {
          scope: "Final result",
          kind: "projection",
          text: "Return each source title and URL.",
          sql: "SELECT title, url FROM sources LIMIT 24",
        },
      ],
      omitted_steps: 0,
    },
    intent_status: "provided",
    answer_intent: {
      question: "List championship seasons with their opponent and score.",
      row_unit: "One championship season",
      fields: [
        { key: "season", meaning: "Championship season year" },
        { key: "opponent", meaning: "Opponent in the referenced game" },
      ],
    },
    output_columns: ["title", "url"],
    missing_intended_fields: ["season", "opponent"],
    result_observations: { row_count: 24, null_cells: [] },
  };
}

function render(value?: QueryFeedback) {
  return renderToStaticMarkup(
    createElement(QueryFeedbackPanel, { feedback: value }),
  );
}

test("query review contrasts the recorded answer with actual document rows, without certifying the result", () => {
  const html = render(feedback());
  assert.match(html, /One championship season/);
  assert.match(html, /Return up to 24 source documents/);
  assert.match(html, /Requested fields absent from the returned columns/);
  assert.match(html, /The query returned 24 rows/);
  assert.match(html, /does not verify factual accuracy or complete coverage/);
  assert.match(html, /Later corrections may differ/);
  assert.match(html, /<details[^>]*><summary>Query steps/);
  assert.match(html, /SELECT title, url FROM sources LIMIT 24/);
  assert.doesNotMatch(
    html,
    /<button|<form|<a\b|verified answer|quality score/i,
  );
});

test("old tables and unavailable descriptions remain usable without an invented explanation", () => {
  const old = render();
  assert.match(old, /No query description was recorded/);
  assert.match(old, /You can still explore its results and sources/);
  assert.doesNotMatch(old, /Intended answer|Query identifiers|Actual query/);

  const value = feedback();
  value.description_status = "unavailable";
  delete value.description;
  value.intent_status = "not_provided";
  delete value.answer_intent;
  value.missing_intended_fields = [];
  const unavailable = render(value);
  assert.match(unavailable, /plain-language description is unavailable/);
  assert.match(unavailable, /No intended answer was recorded/);
  assert.match(unavailable, /The query returned 24 rows/);
  assert.doesNotMatch(
    unavailable,
    /One championship season|Return up to 24 source documents/,
  );
});

test("partial descriptions and empty cells are explicit observations, not blocking errors", () => {
  const value = feedback();
  value.description!.omitted_steps = 3;
  value.result_observations = {
    row_count: 1,
    null_cells: [{ key: "opponent", count: 1 }],
  };
  const html = render(value);
  assert.match(html, /3 additional query steps are not included/);
  assert.match(html, /The query returned 1 row\./);
  assert.match(html, /Empty cells at query completion/);
  assert.match(html, /does not make the other results invalid/);
  assert.doesNotMatch(html, /role="alert"|disabled|retry|failed/i);
});

test("intent, SQL fragments, columns and observations render as escaped plain text", () => {
  const value = feedback();
  value.answer_intent!.question = '<img src="x" onerror="alert(1)">';
  value.description!.summary = "<script>host.callServerTool()</script>";
  value.description!.steps[0].sql =
    '<svg onload="fetch(\"https://example.com\")">';
  value.output_columns = ["<iframe src='https://example.com'>"];
  value.missing_intended_fields = ["<button>Accept</button>"];
  const html = render(value);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;svg/);
  assert.match(html, /&lt;iframe/);
  assert.match(html, /&lt;button&gt;Accept/);
  assert.doesNotMatch(html, /<img|<script|<svg|<iframe|<button/);
});
