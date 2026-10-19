import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ResearchJobStatusPanel,
  type ResearchJobStatusPanelProps,
} from "../src/job-status-panel.js";
import type { ResearchCapacity, ResearchJobView } from "../src/job-view.js";
function view(job: Partial<ResearchJobView["job"]> = {}): ResearchJobView {
  return {
    kind: "research_job_status",
    job: {
      job_id: "b31e5012-b76c-46c3-94f9-fb175e35d263",
      request_id: "ebeb10cc-e869-46c8-8070-514443fe570a",
      status: "queued",
      pending: true,
      can_resume: true,
      ...job,
    },
  };
}
function capacity(values: Partial<ResearchCapacity> = {}): ResearchCapacity {
  return {
    resource: "flight_compute",
    reason: "operator_limit",
    period: "day",
    allowance: "configured",
    ...values,
  };
}
function render(
  value = view(),
  overrides: Partial<ResearchJobStatusPanelProps> = {},
) {
  return renderToStaticMarkup(
    createElement(ResearchJobStatusPanel, {
      view: value,
      busy: false,
      onCheck() {},
      onResume() {},
      ...overrides,
    }),
  );
}
function button(html: string, name: string) {
  const match = [
    ...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),
  ].find((item) => item[2].replace(/<[^>]*>/g, "").trim() === name);
  assert.ok(match, `Expected button: ${name}`);
  return { disabled: /\bdisabled(?:=|\s|$)/.test(match[1]) };
}
test("configured daily capacity is an application limit, never a vendor free allowance", () => {
  const html = render(view({ capacity: capacity() }));
  assert.match(html, /Research capacity is used up for today/);
  assert.match(html, /configured application limit/);
  assert.doesNotMatch(html, /Free hosted|MotherDuck/);
  assert.equal(button(html, "Resume research").disabled, true);
  assert.equal(button(html, "Check status").disabled, false);
});
test("monthly and unknown configured periods never invent a reset date", () => {
  const monthly = render(view({ capacity: capacity({ period: "month" }) }));
  assert.match(monthly, /used up for this month/);
  assert.doesNotMatch(monthly, /for today|<time/);
  const unknown = render(view({ capacity: capacity({ period: "unknown" }) }));
  assert.match(unknown, /Research capacity is used up/);
  assert.doesNotMatch(unknown, /for today|this month|tomorrow|<time/);
});
test("only provider-reported included allowances get the free-capacity label for their actual period", () => {
  for (const period of ["day", "month", "unknown"] as const) {
    const html = render(
      view({
        capacity: capacity({
          reason: "provider_limit",
          allowance: "included",
          period,
        }),
      }),
    );
    assert.match(html, /Free hosted capacity is used up/);
    if (period === "day") assert.match(html, /for today/);
    if (period === "month") {
      assert.match(html, /for this month/);
      assert.doesNotMatch(html, /for today/);
    }
    if (period === "unknown")
      assert.doesNotMatch(html, /for today|this month|<time/);
  }
  const operator = render(
    view({ capacity: capacity({ allowance: "included" }) }),
  );
  assert.doesNotMatch(operator, /Free hosted/);
  assert.match(operator, /configured application limit/);
  assert.doesNotMatch(
    render(view({ capacity: capacity({ reason: "provider_limit" }) })),
    /Free hosted/,
  );
});
test("unknown provider allowance and account configuration cannot claim free exhaustion", () => {
  const unknown = render(
    view({
      capacity: capacity({ reason: "provider_limit", allowance: "unknown" }),
    }),
  );
  assert.match(unknown, /hosting provider reported a capacity limit/);
  assert.doesNotMatch(unknown, /Free hosted/);
  const setup = render(
    view({ capacity: capacity({ reason: "account_configuration" }) }),
  );
  assert.match(setup, /Hosted research needs account setup/);
  assert.doesNotMatch(setup, /used up|Free hosted/);
});
test("explicit reset dates use the exact timestamp and local Intl formatting", () => {
  const at = "2026-11-01T05:30:00Z",
    html = render(
      view({ capacity: capacity({ period: "month", resets_at: at }) }),
    );
  const expected = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(at));
  assert.ok(html.includes(expected));
  assert.match(html, /<time dateTime="2026-11-01T05:30:00Z"/);
  assert.doesNotMatch(
    render(view({ capacity: capacity({ resets_at: "not-a-date" }) })),
    /<time|Invalid Date/,
  );
});
test("actual capacity measurements retain units without inventing missing values", () => {
  assert.match(
    render(
      view({ capacity: capacity({ used: 600, limit: 600, unit: "seconds" }) }),
    ),
    /10 minutes of 10 minutes reserved/,
  );
  assert.match(
    render(
      view({
        capacity: capacity({
          resource: "search_model_budget",
          used: 10_000,
          limit: 20_000,
          unit: "microusd",
        }),
      }),
    ),
    /\$0\.01 of \$0\.02 reserved/,
  );
  assert.match(
    render(view({ capacity: capacity({ used: 1, unit: "microusd" }) })),
    /Reserved: \$0\.000001/,
  );
  assert.doesNotMatch(
    render(view({ capacity: capacity({ used: 600, limit: 600 }) })),
    /job-status-usage/,
  );
});
test("resume requires eligibility, no capacity block, and no busy action", () => {
  assert.equal(button(render(), "Resume research").disabled, false);
  assert.equal(
    button(render(view({ can_resume: false })), "Resume research").disabled,
    true,
  );
  assert.equal(
    button(render(view({ capacity: capacity() })), "Resume research").disabled,
    true,
  );
  const busy = render(view(), { busy: true });
  assert.equal(button(busy, "Resume research").disabled, true);
  assert.equal(button(busy, "Check status").disabled, true);
});
test("uncertain submissions override capacity messaging and cannot resume despite malformed eligibility", () => {
  const html = render(
    view({
      status: "submission_unknown",
      can_resume: true,
      capacity: capacity(),
    }),
  );
  assert.match(html, /Awaiting submission confirmation/);
  assert.match(html, /may already be running/);
  assert.match(html, /do not submit it again/);
  assert.doesNotMatch(html, /used up for today/);
  assert.equal(button(html, "Resume research").disabled, true);
  assert.equal(button(html, "Check status").disabled, false);
});
test("running, submitting, failed and cancelled jobs retain truthful state labels", () => {
  const labels = {
    dispatching: "Starting research",
    running: "Research is running",
    failed: "Research did not complete",
    cancelled: "Research was cancelled",
  } as const;
  for (const [status, label] of Object.entries(labels)) {
    const html = render(view({ status: status as keyof typeof labels }));
    assert.ok(html.includes(label));
    assert.equal(button(html, "Resume research").disabled, true);
    const withCapacity = render(
      view({ status: status as keyof typeof labels, capacity: capacity() }),
    );
    assert.ok(withCapacity.includes(label));
  }
});
test("completed jobs can open only actual saved results through an available callback", () => {
  const completed = view({
    status: "completed",
    pending: false,
    result_id: "wq_saved_result",
  });
  const html = render(completed, { onOpenResult() {} });
  assert.match(html, /Research step completed/);
  assert.equal(button(html, "Open saved result").disabled, false);
  assert.doesNotMatch(html, /Resume research/);
  assert.equal(
    button(
      render(completed, { busy: true, onOpenResult() {} }),
      "Open saved result",
    ).disabled,
    true,
  );
  assert.doesNotMatch(render(completed), /Open saved result/);
  assert.doesNotMatch(
    render(view({ status: "completed", pending: false }), {
      onOpenResult() {},
    }),
    /Open saved result/,
  );
  assert.doesNotMatch(
    render(view({ result_id: "wq_stale_result" }), { onOpenResult() {} }),
    /Open saved result/,
  );
});
test("status updates announce politely and errors are escaped text", () => {
  const html = render(view(), { error: '<img src=x onerror="bad()">' });
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /role="alert"/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img/);
});
test("rendering never checks, resumes or opens results automatically", () => {
  let calls = 0;
  const callbacks = {
    onCheck() {
      calls++;
    },
    onResume() {
      calls++;
    },
    onOpenResult() {
      calls++;
    },
    onOpenBilling() {
      calls++;
    },
  };
  for (const status of [
    "queued",
    "running",
    "submission_unknown",
    "completed",
    "failed",
    "cancelled",
  ] as const) {
    render(view({ status, result_id: "wq_saved_result" }), callbacks);
    render(view({ status, capacity: capacity() }), callbacks);
  }
  assert.equal(calls, 0);
});

function billingLinks(html: string) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((item) => ({
    attributes: item[1],
    href: /href="([^"]+)"/.exec(item[1])?.[1],
    label: item[2].replace(/<[^>]*>/g, "").trim(),
  }));
}
test("capacity lists only the relevant provider billing accounts, with no inferred default", () => {
  const html = render(
    view({ capacity: capacity({ services: ["motherduck", "exa"] }) }),
  );
  assert.deepEqual(
    billingLinks(html).map((link) => link.label),
    ["MotherDuck billing", "Exa billing"],
  );
  assert.match(html, /aria-label="Provider billing"/);
  assert.equal(billingLinks(render(view({ capacity: capacity() }))).length, 0);
  assert.doesNotMatch(render(view({ capacity: capacity() })), /adding a card/);
});
test("all provider links use verified hardcoded HTTPS billing destinations", () => {
  const html = render(
    view({
      capacity: capacity({
        services: [
          "motherduck",
          "exa",
          "brave",
          "serper",
          "deepseek",
          "openai",
        ],
      }),
    }),
  );
  const links = billingLinks(html);
  assert.deepEqual(
    links.map((link) => link.href),
    [
      "https://app.motherduck.com/settings/billing",
      "https://dashboard.exa.ai/billing",
      "https://api-dashboard.search.brave.com/app/settings/billing?tab=payment-method",
      "https://serper.dev/billing",
      "https://platform.deepseek.com/",
      "https://platform.openai.com/account/billing/overview",
    ],
  );
  for (const link of links) {
    assert.match(link.attributes, /target="_blank"/);
    assert.match(link.attributes, /rel="noopener noreferrer"/);
  }
});
test("forged service names or backend URLs cannot create links, including object-prototype keys", () => {
  const untrusted = {
    ...capacity(),
    services: [
      "exa",
      "__proto__",
      "constructor",
      "https://evil.example/billing",
      "exa",
    ],
    billing_url: "https://evil.example/billing",
  } as unknown as ResearchCapacity;
  const html = render(view({ capacity: untrusted }));
  assert.deepEqual(
    billingLinks(html).map((link) => link.href),
    ["https://dashboard.exa.ai/billing"],
  );
  assert.doesNotMatch(html, /evil\.example|__proto__|constructor/);
});
test("billing remains optional and cannot bypass configured limits or explicit resume", () => {
  const value = view({ capacity: capacity({ services: ["motherduck"] }) });
  const html = render(value);
  assert.match(html, /Upgrades or adding a card are optional/);
  assert.match(html, /Configured app limits may still need adjustment/);
  assert.match(html, /Billing changes do not resume this job/);
  assert.match(html, /Your job is saved/);
  assert.equal(button(html, "Resume research").disabled, true);
  for (const status of ["submission_unknown", "running", "completed"] as const)
    assert.equal(
      billingLinks(render(view({ ...value.job, status }))).length,
      0,
    );
});
test("rendering billing options never opens a page, checks status, or resumes research", () => {
  let calls = 0;
  render(view({ capacity: capacity({ services: ["motherduck", "exa"] }) }), {
    onOpenBilling() {
      calls++;
    },
    onCheck() {
      calls++;
    },
    onResume() {
      calls++;
    },
  });
  assert.equal(calls, 0);
});
test("an explicit billing click uses the trusted host callback without checking or resuming", () => {
  const destinations: string[] = [];
  let navigationPrevented = false,
    researchCalls = 0;
  const tree = ResearchJobStatusPanel({
    view: view({ capacity: capacity({ services: ["exa"] }) }),
    busy: false,
    onCheck() {
      researchCalls++;
    },
    onResume() {
      researchCalls++;
    },
    onOpenBilling(url) {
      destinations.push(url);
    },
  });
  const elements = (node: unknown): ReactElement<Record<string, unknown>>[] => {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!node || typeof node !== "object" || !("props" in node)) return [];
    const element = node as ReactElement<Record<string, unknown>>;
    return [element, ...elements(element.props.children)];
  };
  const anchor = elements(tree).find((element) => element.type === "a")!;
  assert.ok(anchor);
  assert.equal(destinations.length, 0);
  (anchor.props.onClick as (event: { preventDefault(): void }) => void)({
    preventDefault() {
      navigationPrevented = true;
    },
  });
  assert.deepEqual(destinations, ["https://dashboard.exa.ai/billing"]);
  assert.equal(navigationPrevented, true);
  assert.equal(researchCalls, 0);
});
