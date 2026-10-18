# Provider-managed research usage

New personal-cloud plans explicitly set `SOURCESQL_USAGE_MODE=provider_managed`.
The selected provider manages payment methods, included credits and paid usage.
SourcesQL does not ask for a second billing authorization. Historical application
reservation counters are retained but neither increment nor block dispatch in
this mode. Finite per-job runtime, search, model and token limits still apply.
Only one Flight may be active for the owner; uncertain submissions are inspected
using the same handle and never automatically replayed.

Existing deployments without a usage mode retain `operator_reserved` behavior.
Changing an existing deployment requires an explicit reviewed configuration;
installing a package does not silently enable additional spending elsewhere.

## Metering and notices

Durable run receipts retain provider responses, including Exa's cost estimates
and model token counts. Completed, failed and cancelled runs are all included.
Provider request IDs deduplicate repeated observations. Cache reads and work
known not to have dispatched do not count as provider requests. Unreported
charges and uncertain outcomes remain explicitly unavailable, not zero.

When a Flight reaches a terminal platform state, its exact `started_at`,
`ended_at` and elapsed seconds are retained once. Runtime-based F4 cost is an
estimate using the published regional rate. Separate MotherDuck SQL compute,
storage, credits and invoice adjustments are not measured by Flight wall time.
Older or unobserved platform runtimes remain visible as an unknown count.
Allowance notices observe recent platform runs once and summarize month/day
usage from the same read snapshot; they do not repeat the platform scan for each
window.

The app displays a dismissible, nonblocking overlay when observed sourcesQL
usage reaches a reference allowance: Exa $10 per UTC calendar month, or no-card
MotherDuck F4's 1,800 seconds per UTC day. Notices do not inspect payment methods,
require administrative credentials, start jobs or change provider plans. They
include a provider billing link and never replace the saved table. Dismissals
persist in the owner's store across cards and chats. Widget state provides an
immediate fallback if the acknowledgement cannot reach the server.

These are reference thresholds, not account entitlements. Exa onboarding bonuses
or purchased credits can increase availability. MotherDuck card-enabled Lite
shares a monthly compute allocation with database work rather than the no-card
daily Flight reference. Other applications may consume the same provider
allowance. Notice copy therefore identifies estimated sourcesQL activity and
does not claim the account's free credits are exhausted.

## Provider refusal and recovery

Allowlisted HTTP 402/429 diagnostics distinguish provider credit, spending and
rate limits, with an optional provider retry delay. Raw error bodies and messages
stay private. Capacity metadata selects only hardcoded provider billing URLs.
A failure keeps completed work and its original job/run identity; a billing link
does not replay the failed request. Transport uncertainty remains uncertainty,
not evidence of depleted credits. MotherDuck submission errors without a
confirmed refusal remain `submission_unknown` and require inspection.

## Cost reports

The authenticated owner can call `sourcesql_usage_report` with optional ISO
`start`/`end` bounds (at most 366 days) and an optional `job_id`. The default is
the current UTC calendar month. Reports expose only metering fields, not SQL,
research rows, URLs or credentials. Anonymous disclosure contexts cannot read
owner usage. Reports do not dispatch searches, models or Flights.

Reports separate provider cost estimates, reported costs when available, token
counts, uncertain requests, observed Flight runtime and unavailable cost
components. Operations use their run's start period; a workflow spanning several
jobs needs an interval or separate reports for its known job handles. Provider
account reconciliation and exact invoices are outside this initial implementation.

References: [Exa pricing](https://exa.ai/pricing),
[Exa response estimates](https://exa.ai/docs/reference/search),
[MotherDuck Flight billing](https://motherduck.com/docs/about-motherduck/billing/flight-sizes/).


DeepSeek receipts keep two amounts separate. `estimated_cost_microusd` uses the
published rate for successful nonempty results, while `reserved_cost_microusd`
in the report sums the operator-configured request reservations recorded in
receipts. A conservative 1,000-microUSD reservation can therefore correspond to
a 750-microUSD usage estimate. Valid empty responses can estimate zero while
retaining their reservation. Older receipts without reservation metadata report
that amount as unavailable; uncertain provider outcomes remain unknown. Neither
field is an invoice, remaining balance or a claim about consumed free credits.
