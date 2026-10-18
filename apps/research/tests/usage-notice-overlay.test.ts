import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageNotice } from "../src/usage.js";
import {
  UsageNoticeOverlay,
  dismissedUsageNoticeKeys,
  firstUndismissedUsageNotice,
  usageNoticeKey,
  withDismissedUsageNotice,
} from "../src/usage-notice-overlay.js";

const exa: UsageNotice = {
  id: "notice-exa-1",
  service: "exa",
  period: "month",
  period_start: "2026-10-01T00:00:00.000Z",
  period_end: "2026-11-01T00:00:00.000Z",
  used: 10_020_000,
  allowance: 10_000_000,
  unit: "microusd",
  basis: "estimated",
  scope: "sourcesql",
  blocking: false,
};
const motherduck: UsageNotice = {
  ...exa,
  id: "notice-motherduck-1",
  service: "motherduck",
  period: "day",
  period_start: "2026-10-18T00:00:00.000Z",
  period_end: "2026-10-19T00:00:00.000Z",
  used: 1810,
  allowance: 1800,
  unit: "seconds",
};
function render(notices?: UsageNotice[]) {
  return renderToStaticMarkup(createElement(UsageNoticeOverlay, { notices }));
}

test("Exa allowance notice is estimated, nonblocking and links only to provider billing", () => {
  const html = render([exa]);
  assert.match(html, /Exa free allowance reached \(estimate\)/);
  assert.match(
    html,
    /Estimated sourcesQL usage: \$10\.02 \/ \$10\.00 monthly allowance/,
  );
  assert.match(html, /Research continues while your provider allows it/);
  assert.match(html, /role="status" aria-atomic="true"/);
  assert.match(html, /href="https:\/\/dashboard\.exa\.ai\/billing"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /aria-label="Dismiss usage notice"/);
  assert.doesNotMatch(
    html,
    /role="alert"|role="dialog"|disabled|Resume research|Authorize|card required/i,
  );
});

test("MotherDuck daily usage is independent of the Exa monthly allowance", () => {
  const html = render([motherduck]);
  assert.match(html, /MotherDuck free allowance reached \(estimate\)/);
  assert.match(html, /30\.2 min \/ 30 min daily allowance/);
  assert.match(
    html,
    /href="https:\/\/app\.motherduck\.com\/settings\/billing"/,
  );
  assert.doesNotMatch(html, /dashboard\.exa/);
});

test("dismissals deduplicate service periods rather than mutable receipt IDs and allow the next period", () => {
  const key = usageNoticeKey(exa);
  const samePeriod = { ...exa, id: "new-receipt", used: 11_000_000 };
  const nextMonth = {
    ...exa,
    period_start: "2026-11-01T00:00:00.000Z",
    period_end: "2026-12-01T00:00:00.000Z",
  };
  assert.equal(usageNoticeKey(samePeriod), key);
  assert.equal(
    firstUndismissedUsageNotice([exa, samePeriod], [key]),
    undefined,
  );
  assert.equal(
    firstUndismissedUsageNotice([samePeriod, motherduck], [key]),
    motherduck,
  );
  assert.equal(firstUndismissedUsageNotice([nextMonth], [key]), nextMonth);
  assert.equal(firstUndismissedUsageNotice(undefined, []), undefined);
});

test("persisting a dismissal preserves other widget state and both provider notices", () => {
  const original = {
    selectedRow: "row-42",
    navigation: { snapshot: "saved-research" },
  };
  const first = withDismissedUsageNotice(original, usageNoticeKey(exa));
  const both = withDismissedUsageNotice(first, usageNoticeKey(motherduck));
  const again = withDismissedUsageNotice(both, usageNoticeKey(exa));
  assert.equal(again.selectedRow, original.selectedRow);
  assert.equal(again.navigation, original.navigation);
  assert.deepEqual(dismissedUsageNoticeKeys(again), [
    usageNoticeKey(exa),
    usageNoticeKey(motherduck),
  ]);
  assert.deepEqual(original, {
    selectedRow: "row-42",
    navigation: { snapshot: "saved-research" },
  });
  assert.deepEqual(dismissedUsageNoticeKeys(null), []);
  assert.deepEqual(
    dismissedUsageNoticeKeys({
      sourcesqlUsageNoticeDismissalsV1: [null, 7, usageNoticeKey(exa)],
    }),
    [usageNoticeKey(exa)],
  );
});

test("absent notices are hidden and inert, without a billing destination", () => {
  const html = render();
  assert.match(html, /data-state="hidden"/);
  assert.match(html, /aria-hidden="true" inert=""/);
  assert.doesNotMatch(html, /href=/);
});

test("rendering a usage notice never acknowledges or dismisses it automatically", () => {
  const dismissed: UsageNotice[] = [];
  const html = renderToStaticMarkup(
    createElement(UsageNoticeOverlay, {
      notices: [exa],
      onDismiss: (notice) => dismissed.push(notice),
    }),
  );
  assert.match(html, /data-state="visible"/);
  assert.deepEqual(dismissed, []);
});
