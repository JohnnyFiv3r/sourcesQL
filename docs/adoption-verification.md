# Adoption verification

A package install, a working gateway and a rendered MCP App establish different
parts of the adoption path. Keep their evidence separate when qualifying a new
release or helping someone connect their own account.

## Published baseline: 0.1.2

The published **0.1.2** wheel was installed into a fresh Python 3.13 environment
outside the checkout on 2026-10-15. Its SHA256 matched the public release. The
installed CLI completed synthetic research, reopened its stored result and
imported its portable bundle without network access. Personal-cloud planning
worked twice with the same digest and recovered through `status`. The default
release download also fetched the exact installed version from PyPI and verified
the published wheel digest. No account resources, Flights or provider requests
were created by these checks. Installed release checks on Python 3.12, 3.13 and
3.14 are also part of the release workflow.

The personal-cloud setup regressions cover account and destination checks,
private credential handling, plan integrity, recovery after uncertain resource
creation, and explicit retries for a failed deployment. These are synthetic API
checks; they do not establish that a newly registered account can complete every
signup, consent or plan requirement.

## Current candidate: 0.2.0

Compact checkpoints and bounded manual evidence-backed updates are implemented
in source and the personal Preview. The candidate wheel and source distribution
each passed installed qualification outside the checkout on Python 3.12, 3.13
and 3.14. The app, restricted Docker runtime and actual Python/SQL worker passed
controlled checks, including review changes, successor publication, repeatable
materialization and subsequent SQL.

The authenticated hosted MCP endpoint passed checkpoint recovery with the
original saved ID, fresh-connection continuation, durable manual-request reopening
and explicit cancellation. Those checks used stored synthetic data without new
Flights or provider requests. Actual ChatGPT controls then passed selected-field
checkpoint saving and update-request delivery/read/cancellation. A fresh Claude
chat resumed the same checkpoint as `ready`; an older chat had retained its old
tool list. Claude also rendered the current controls, saved an update request
and prepared a composer message. After Send, the agent read and cancelled that
exact request. Snapshot values, amendments, accepted sources and revision stayed
unchanged. Actual proposal review/publication and checkpoint file download remain
separate host gates. Candidate checks do not change the published PyPI version or
qualify a fresh adopter's account.

A subsequent notification patch explains that some hosts prepare a composer
message requiring Send. Its build, targeted UI/deployment checks and Python
packaging checks passed. Authenticated resource reads match the exact local UI
and retain the previous immutable bundle; the actual-host observations above
used that previous bundle. This copy change did not repeat full engine checks.

Use the direct authenticated HTTPS MCP connection for hosted clients. There is
no separate packaged-plugin installation requirement.

## Qualification boundaries

| Path | Observed | Still needs separate qualification |
| --- | --- | --- |
| Python package | Published wheel install, fixture execution, stored reopening, portable import and repeatable cloud planning | A new release needs its own artifact checks |
| Personal cloud | Existing-account provisioning, bounded fixture execution and subsequent stored reads | Fresh-account Hobby onboarding and its manual account steps |
| Exa | Earlier bounded hosted Auto research and durable results | Current provider configuration and broad research quality |
| Brave and Serper | One bounded search per provider in real MotherDuck Flights, provenance, replay and fresh stored reads through a local MCP gateway | Dispatch through Vercel HTTP and host rendering for those configurations |
| ChatGPT | Direct HTTPS with OAuth, current table rendering, checkpoint saving and update-request delivery/read/cancellation | Actual evidence review, revised choices, successor publication and checkpoint file download |
| Claude | Saved-table rendering, current controls, child/Back navigation, correction persistence, checkpoint continuation from ChatGPT and update-request read/cancel after Send | Tracked expansion, refresh review and manual-update evidence review/publication |
| Cursor | Local Docker fixture rendering and paging | Hosted authentication and full lifecycle; app messaging was unavailable in the tested setup |
| Continuation candidate | Installed artifacts, controlled engine/app/Docker/browser checks and stored-data hosted MCP recovery | Actual client workflows and fresh-adopter verification for the changed release |

See [client connection details](clients.md) for the actual host boundaries and
[current status](../STATUS.md) for release evidence.

## Verify an adopter's workspace

1. Install the published package outside a source checkout. Run the local fixture
   example and reopen its stored result before configuring paid providers.
2. Prepare a personal-cloud plan with `fixture` and execution disabled. Review the
   account, database, alias, owner identity and finite limits before applying its
   exact digest. Keep the workspace and receipts private.
3. Finish account login, OAuth consent and any exact-domain protection exception
   deliberately. Setup does not create accounts, accept terms, add a card or
   change a subscription.
4. Run the installed `verify` command against the saved plan. Its ordinary path
   checks MCP connectivity and can reopen an existing fixture result without
   submitting a new research job. `--run-fixture` deliberately permits one fixture
   execution and requires that execution was enabled in the reviewed plan.
5. Add the direct authenticated HTTPS endpoint in the intended MCP client. Open
   the saved result and confirm the actual component, source opening, navigation
   and supported actions; a successful MCP response alone does not prove
   rendering or app-message delivery.
6. For the continuation candidate, save and reopen a compact checkpoint. Inspect
   its exact revision and selected canonical IDs, then use controlled evidence
   to review a manual update. Change a choice before publication, reopen the
   published successor and confirm the original table is unchanged. Record these
   separately from protocol-only and local-browser checks.
7. Qualify a live provider only under a separate finite allowance. Record the
   exact deployment, provider policy, job ID, result, request count and recovery
   behavior. Keep provider billing distinct from application reservations.

Application reservations are conservative dispatch guards. They are neither a
measurement of provider charges nor an account-wide guarantee that infrastructure
usage remains free. When a daily guard is exhausted, retain the queued job and
resume explicitly after capacity becomes available; do not reset the ledger or
create another namespace to bypass it.
