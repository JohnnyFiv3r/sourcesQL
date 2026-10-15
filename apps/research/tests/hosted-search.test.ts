import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  hostedSearchBudgets,
  hostedSearchConfiguration,
  hostedSearchDescriptor,
  hostedSearchFingerprint,
  validateHostedSearchPolicy,
  type HostedSearchPolicy,
} from "../server/hosted-search.js";
import { exaDescriptor, exaFingerprint } from "../server/hosted-exa.js";

for (const provider of ["brave", "serper"] as const) {
  const policy: HostedSearchPolicy = {
    provider,
    secretName: `sourcesql_${provider}`,
    approvedCostMicrousd: 50_000,
    dailyCostMicrousd: 100_000,
    requestCostMicrousd: 5_000,
  };
  test(`${provider} policy has canonical token-free descriptor and bound Flight configuration`, () => {
    assert.deepEqual(hostedSearchDescriptor(policy), {
      approved_cost_microusd: 50_000,
      provider,
      request_cost_microusd: 5_000,
      secret_name: `sourcesql_${provider}`,
      version: `${provider}-search.v1`,
    });
    assert.equal(
      hostedSearchFingerprint(policy),
      createHash("sha256")
        .update(JSON.stringify(hostedSearchDescriptor(policy)))
        .digest("hex"),
    );
    const config = hostedSearchConfiguration(policy);
    assert.equal(config[`SOURCESQL_ALLOW_LIVE_${provider.toUpperCase()}`], "1");
    assert.equal(
      config[`SOURCESQL_${provider.toUpperCase()}_REQUEST_COST_MICROUSD`],
      "5000",
    );
    assert.ok(!JSON.stringify(config).includes("API_KEY"));
    assert.notEqual(
      hostedSearchFingerprint(policy),
      hostedSearchFingerprint({ ...policy, requestCostMicrousd: 5_001 }),
    );
  });
  test(`${provider} cost estimate bounds attempts and all expensive operations stay unavailable`, () => {
    const budgets = hostedSearchBudgets(
      { max_cost_microusd: 5_000 },
      policy,
      100,
    );
    assert.equal(budgets.max_search_requests, 1);
    assert.equal(budgets.max_search_queries, 1);
    assert.equal(budgets.max_candidates, 10);
    assert.equal(budgets.dispatch_deadline_seconds, 60);
    for (const field of [
      "max_fetches",
      "max_model_requests",
      "max_semantic_documents",
      "max_input_tokens",
      "max_output_tokens",
    ])
      assert.equal(budgets[field], 0);
    assert.equal(
      hostedSearchBudgets({}, policy, 40).dispatch_deadline_seconds,
      40,
    );
    for (const input of [
      { max_search_requests: 3 },
      { max_search_queries: 3 },
      { max_cost_microusd: 4_999 },
      { max_candidates: 11 },
      { max_fetches: 1 },
      { max_model_requests: 1 },
      { max_concurrency: 2 },
      { unexpected: 1 },
      { max_cost_microusd: Number.NaN },
    ])
      assert.throws(() => hostedSearchBudgets(input, policy, 100));
  });
  test(`${provider} approval fields cannot be missing, unbounded or untrusted names`, () => {
    for (const override of [
      { requestCostMicrousd: 0 },
      { requestCostMicrousd: 50_001 },
      { requestCostMicrousd: 1.5 },
      { dailyCostMicrousd: 49_999 },
      { dailyCostMicrousd: 1_000_001 },
      { approvedCostMicrousd: Infinity },
      { secretName: "UPPERCASE" },
      { secretName: "name'quoted" },
      { provider: "unknown" },
    ])
      assert.throws(() =>
        validateHostedSearchPolicy({
          ...policy,
          ...override,
        } as HostedSearchPolicy),
      );
  });
}

test("legacy Exa descriptors and fingerprints are unchanged", () => {
  const policy = {
    approvedCostMicrousd: 50_000,
    dailyCostMicrousd: 1_000_000,
    secretName: "sourcesql_exa",
  };
  assert.deepEqual(exaDescriptor(policy), {
    approved_cost_microusd: 50_000,
    secret_name: "sourcesql_exa",
    version: "exa-search.v1",
  });
  assert.equal(
    exaFingerprint(policy),
    "d46b097da9f7ac09575bd9916889aa2a944c3013e163b0079e98585708318004",
  );
  assert.equal(
    exaFingerprint({ ...policy, policyVersion: "exa-research.v2" }),
    "5e31ea3484b972d2f9b0c9e69ad88f226582b19234e236bc6c3dca5bf0e1e901",
  );
});
