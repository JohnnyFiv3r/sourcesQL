# Reviewed hosted qualification

These source-checkout scripts require Node 24 and the locked app dependencies.
They print an offline plan by default. The plan reports what an executed command
would do; it does not connect to MotherDuck, read credentials or write a receipt.

Every command requires `--setup`, `--principal`, `--policy` and `--output`.
The principal must match the setup receipt's existing owner namespace. Receipts
must be separate JSON files under ignored `local/` or `artifacts/` directories.
Neither a new principal nor a fresh receipt resets a provider account's usage.
Do not change the principal to evade limits.

Prepare an operator-owned, reviewed policy JSON outside public artifacts:

```json
{
  "schema": "sourcesql.qualification-policy.v1",
  "setup_sha256": "SHA256_OF_THE_EXACT_EXISTING_SETUP_JSON",
  "source_commit": "EXACT_REVIEWED_40_CHARACTER_SOURCE_COMMIT",
  "usage_mode": "THE_EXISTING_REVIEWED_MODE",
  "max_runtime_sec": 120,
  "daily_seconds": null,
  "monthly_seconds": null,
  "monthly_provider_cost_microusd": null
}
```

The placeholders must be replaced. Copy the existing configuration's metering
mode and all configured runtime/provider reservation limits; do not increase them
for a test. Use `null` only for an unset optional limit. In `operator_reserved`
mode name at least the existing daily or monthly runtime ledger explicitly. In
`provider_managed` mode unset ledgers can remain `null`; the qualifier does not
switch modes or create a new spending grant. The runtime ceiling must match the
setup receipt. The engine still verifies the deployed Flight's owner, F4 size,
unscheduled status, runtime, source, dependencies and provider fingerprint before
submission. A policy file describes the reviewed configuration; it is not proof
that the caller received authorization to execute it.

For example, from the checkout root, print a plan for a fixture Flight:

```sh
apps/research/node_modules/.bin/tsx scripts/qualify-motherduck.mts \
  --setup local/qualification/hosted-setup.json \
  --principal EXISTING_OWNER_ID \
  --policy local/qualification/execution-policy.json \
  --output artifacts/qualification/storage.json \
  --action query
```

Add `--execute --submit` only for an already-approved Flight action. Subsequent
`--action status --execute` inspects the same receipt's exact jobs without
submitting queued work. `--job query` restricts storage status inspection to that
named receipt entry. Do not use a different receipt after a lost acknowledgement;
inspect the retained request/job instead.

The storage actions retain the existing synthetic discovery, typed import,
derived query, export/restore, exact status/log inspection, stale-write check and
summary scenarios. Run `materialize`, inspect until it completes, then `derived`,
inspect it, then `restore`, inspect it, and finally `read` to check the BIGINT and
round trip. Each submission needs both switches. Runtime run numbers remain
strings and are checked as UBIGINT identities without conversion through a
JavaScript number. Logs and summaries inspect only jobs retained by this receipt.

`--action cancel-running --execute --submit --allow-cancel` creates or recovers
one dedicated synthetic fixture request and cancels only that request's job.
It must be explicitly approved; it never selects arbitrary active work. The
optional `--discard-ack` applies only to the synthetic `query` action and exercises
the existing uncertain-submission path. It does not authorize a retry or a new
request UUID.

The old `guards` action is intentionally unavailable. Its assumption that exactly
720 seconds had been reserved, and the cancellation scenario's increase to 840
seconds, were historical operator settings. Budget refusal is covered by local
controller tests; an ordinary remote qualifier must not raise limits, reset
ledgers or consume extra work to manufacture a guard condition.

For synthetic app persistence and an in-memory MCP loop:

```sh
apps/research/node_modules/.bin/tsx scripts/qualify-motherduck-app.mts \
  --setup local/qualification/hosted-setup.json \
  --principal EXISTING_OWNER_ID \
  --policy local/qualification/execution-policy.json \
  --output artifacts/qualification/app.json --fixture
```

`--fixture` means synthetic data, not offline execution. Adding `--execute`
connects to real MotherDuck and writes app state, corrections and history. The app
qualifier forbids Flight mutation calls and sets submission off. To exercise a
completed stored engine result instead, replace `--fixture` with
`--native-receipt artifacts/qualification/storage.json`. That receipt must carry
the same configuration identity. This proves neither a deployed gateway nor
ChatGPT/Claude rendering. The built local app's resource hash is retained.

The Exa qualifier uses the same four required options. `--action submit` prints a
plan; adding `--execute --submit` requests one explicitly reviewed discovery with
at most one search and three retained candidates, no fetches and no model calls.
`--action inspect --execute` inspects its existing receipt. It reconstructs the
existing search or research descriptor and checks its fingerprint, preserving
model/embedding secret references and the reviewed provider limits. It does not
downgrade a research Flight into the historical search-only policy or claim a full
research-quality pass from this small task.

New receipts bind the setup, execution policy, owner namespace, reviewed source
commit, wheel, Flight source/requirements and provider policy identities. A changed
identity or an old unbound receipt refuses before remote work. Preserve legacy
receipts and inspect their exact jobs through the existing status tools; do not
rename an old receipt into the new format or guess a new association. Use a new
reviewed qualification only after existing uncertain work is settled.

Keep each qualification tier separate: parser/dry-run tests are local; executed
app fixtures use remote storage; executed fixture jobs consume Flight compute;
Exa tasks use the configured live provider. Installed artifacts, deployed gateway
composition and actual host rendering require their own receipts. No command
silently changes plans, widens grants, resets usage or cleans up unrelated work.
