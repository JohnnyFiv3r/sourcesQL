# Adoption and product roadmap

**0.2.0** includes compact checkpoints and bounded manual evidence-backed
updates. Installed distributions, controlled engine/app/Docker paths, and actual
ChatGPT/Claude manual review and publication have been exercised. Fresh-adopter
and remaining client checks stay separate.

Implementation, release and actual host qualification are separate milestones.
See [current status](../STATUS.md) for recorded evidence and
[adoption verification](adoption-verification.md) for the remaining checks.

## Implemented foundation

- **Python distribution:** reproducible wheel and source distribution, trusted
  publishing, fixture execution and installed-artifact checks on Python 3.12–3.14.
- **Guided personal cloud:** reviewed, resumable setup for an adopter's own Vercel
  and MotherDuck accounts, private secrets, one owner and finite execution limits.
  The installed 0.2.1 CLI passed clean setup/resume from an empty workspace
  in an existing eligible Hobby account, one bounded fixture Flight and saved
  reopening. Separate ChatGPT and Claude OAuth connections rendered that result.
- **Search adapters:** Exa, Brave and Serper work locally; hosted gateway,
  Flight-policy and secret-binding paths are implemented. Bounded Brave and Serper
  searches passed in real Flights through a local control gateway.
- **MCP clients:** saved-table checks have passed in ChatGPT and Claude, and local
  Docker rendering and paging have passed in Cursor. Client lifecycle coverage
  remains scoped to the observations in the [client guide](clients.md).
- **Compact checkpoints:** versioned records up to 24 KiB retain the research
  question, scope, selections, query provenance, exact revision/source pins and
  pending identities. Authorized inspection is read-only; stale, missing and
  inaccessible dependencies block continuation.
- **Manual updates:** distinct existing-finding and discovery scopes produce a
  versioned change set with canonical source evidence. Accept/Keep choices remain
  adjustable until publication, with their history retained. Publication creates
  an immutable successor and preserves earlier observations and amendments.
  Complete tables are limited to 100 rows and 200 KB in this first version.

The hosted default is the authenticated HTTPS MCP App connection. A separate
packaged plugin is not needed. Local Docker remains an alternative adoption path.

## 1. Finish adoption verification

Qualify account signup and consent with an eligible adopter's fresh personal
accounts. Clean installed-CLI setup, the static-first deployment path, one bounded
fixture Flight and separate ChatGPT/Claude OAuth rendering have passed in an
existing eligible Hobby workspace. Token renewal, live-provider research and the
full client lifecycle remain separate checks. Keep account creation, consent,
OAuth registration and any exact-domain protection exception visible to the
adopter. Release artifacts receive their own archive and installed-package checks.

Complete the bounded Brave and Serper checks through Vercel HTTP. Record the
provider policy, results, provenance, usage reservations and lost-response
recovery. Wait for existing capacity rather than resetting the ledger or creating
another namespace to bypass its limits. A temporary test-access grant must be
revoked after the check.

Continue to distinguish included service allowances, application reservations
and actual provider billing. No setup path promises free hosting.

## 2. Qualify continuation and updates in actual MCP hosts

ChatGPT checkpoint saving and fresh-Claude continuation have passed, as have
current table rendering, update-request read/cancellation, evidence inspection,
revised review choices and saved successor publication in both hosts.
Claude prepares a composer draft that requires Send before its agent continues.

Use saved data and controlled fixtures for remaining checkpoint stale-revision
and file-download checks. Preserve canonical IDs and original revisions in each
host receipt. Successful tool responses and local browser tests remain separate
from actual host rendering.

Complete the remaining tracked expansion and refresh-review checks in Claude.
For Cursor, qualify hosted authentication and the supported lifecycle separately
from local Docker rendering. Keep actions that require unavailable app messaging
disabled and describe that limitation explicitly. Use a small approved provider
run only when fixture or saved-data checks cannot establish the behavior.

## 3. Keep released artifacts and hosted runtimes aligned

Keep released source, installed artifacts, Docker and deployed resources in
agreement. Publish only artifacts covered by release checks and identify
any remaining host or adopter gates in the release notes. Refresh client tool
definitions after a server update; reopen saved results rather than repeating
research to repair a display failure.

## 4. Support larger manual updates

Extend publication beyond complete inline tables of 100 rows and 200 KB using
engine-backed successors. Preserve canonical row IDs, source versions, observation
times, exact baseline revisions, review history and dependency authorization.
Keep discovery separate from reassessment of existing findings. Missing search
hits must never imply deletion.

Retain explicit materialization for further SQL where the accepted result needs
it, with repeatable job recovery and visible hosted execution cost. Apply SQL
filtering before costly semantic work where the admitted plan supports it. See
[the continuation guide](continuation.md) for the current bounded contracts.

## Later: optional monitoring and expert feedback

Build opt-in research subscriptions after checkpoints and manual updates are
qualified. Evaluate provider change notifications or bounded polling, with
declared coverage, per-watch budgets, visible usage and pause controls. Keep
the current single-active-job and explicit queued-resume policy until a separate
scheduling policy is chosen.

Treat validated expert amendments as permissioned feedback records. Reuse beyond
the originating research set, model training and broader propagation require
their own product decisions and evaluation.
