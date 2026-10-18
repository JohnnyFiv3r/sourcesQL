import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResearchStatusOverlay,
  type ResearchStatus,
} from "../src/research-status-overlay.js";

const pending: ResearchStatus = {
  message: "Waiting for results…",
  kind: "pending",
  pendingRequestIds: ["request-one"],
  canCheck: true,
  canDismiss: false,
};

function render(status?: ResearchStatus, busy = false) {
  return renderToStaticMarkup(
    createElement(ResearchStatusOverlay, {
      status,
      busy,
      onCheck() {},
      onCancel() {},
      onDismiss() {},
    }),
  );
}

test("pending research retains accessible check and cancel controls in its floating status", () => {
  const html = render(pending);
  assert.match(html, /data-state="visible"/);
  assert.match(html, /role="status" aria-atomic="true"/);
  assert.match(html, /Waiting for results…/);
  assert.match(html, /aria-label="Check research status"/);
  assert.match(html, /aria-label="Cancel research request"/);
  assert.doesNotMatch(html, /disabled|Dismiss cancelled/);
  assert.equal((render(pending, true).match(/disabled=""/g) ?? []).length, 2);
});

test("failed checks keep the actual error and recovery action without offering cancellation of a finished request", () => {
  const html = render({
    message: "Couldn’t check for results. Try again.",
    kind: "error",
    pendingRequestIds: [],
    canCheck: true,
    canDismiss: false,
  });
  assert.match(html, /role="alert"/);
  assert.match(html, /Couldn’t check for results. Try again./);
  assert.match(html, /aria-label="Check research status"/);
  assert.doesNotMatch(html, /Cancel research request|research-spinner/);
});

test("cancelled research remains dismissible, while an absent status is hidden and inert", () => {
  const cancelled = render({
    message: "Research cancelled. No results were added.",
    kind: "cancelled",
    pendingRequestIds: [],
    canCheck: false,
    canDismiss: true,
  });
  assert.match(cancelled, /aria-label="Dismiss cancelled research status"/);
  assert.doesNotMatch(
    cancelled,
    /Check research status|Cancel research request/,
  );
  const hidden = render();
  assert.match(hidden, /data-state="hidden"/);
  assert.match(hidden, /aria-hidden="true" inert=""/);
  assert.doesNotMatch(hidden, /<button/);
});

test("poll failures preserve cancellation for each live request and escape supplied error text", () => {
  const html = render({
    ...pending,
    message: '<img src="x" onerror="alert(1)">',
    kind: "error",
    pendingRequestIds: ["request-one", "request-two"],
  });
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(
    (html.match(/aria-label="Cancel research request"/g) ?? []).length,
    2,
  );
});
