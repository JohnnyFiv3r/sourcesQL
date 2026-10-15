# Adoption verification

A package install, a working gateway and a rendered MCP App establish different
parts of the adoption path. Keep their evidence separate when qualifying a new
release or helping someone connect their own account.

## Recorded baseline

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

| Path | Observed | Still needs separate qualification |
| --- | --- | --- |
| Python package | Published wheel install, fixture execution, stored reopening, portable import and repeatable cloud planning | A new release needs its own artifact checks |
| Personal cloud | Existing-account provisioning, bounded fixture execution and subsequent stored reads | Fresh-account Hobby onboarding and its manual account steps |
| Exa | Earlier bounded hosted Auto research and durable results | Current provider configuration and broad research quality |
| Brave and Serper | One bounded search per provider in real MotherDuck Flights, provenance, replay and fresh stored reads through a local MCP gateway | Dispatch through Vercel HTTP and host rendering for those configurations |
| ChatGPT | OAuth, saved-table rendering, navigation and scoped lifecycle checks | Recheck changed workflows in the actual host |
| Claude | Saved-table rendering, child/Back navigation and correction persistence across reload | Tracked expansion and refresh review through host messages |
| Cursor | Local Docker fixture rendering and paging | Hosted authentication and full lifecycle; app messaging was unavailable in the tested setup |

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
5. Open the saved result in the intended MCP client. Confirm the actual component,
   source opening, navigation and supported actions; a successful MCP response
   alone does not prove rendering or app-message delivery.
6. Qualify a live provider only under a separate finite allowance. Record the
   exact deployment, provider policy, job ID, result, request count and recovery
   behavior. Keep provider billing distinct from application reservations.

Application reservations are conservative dispatch guards. They are neither a
measurement of provider charges nor an account-wide guarantee that infrastructure
usage remains free. When a daily guard is exhausted, retain the queued job and
resume explicitly after capacity becomes available; do not reset the ledger or
create another namespace to bypass it.
