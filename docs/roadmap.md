# Adoption and product roadmap

These are the next implementation priorities. They are planned work, not current
installation instructions or additional qualified host claims.

Complete the adoption release first. Compact research checkpoints and manual
evidence-backed updates are the next product milestones.

## 1. PyPI distribution

Publish the Python engine and CLI with a reproducible wheel and source
distribution. Check package-name availability and configure trusted publishing.
Test the artifacts in a clean environment outside the checkout, including a
fixture query, saved-result reopen and the intended setup entrypoint. Make the
relationship between the Python package and the Node MCP App clear in the install
instructions.

## 2. Guided personal-cloud setup

Provide a resumable setup flow for the adopter's own Vercel, MotherDuck and OAuth
accounts. Discover prerequisites, prepare the app and reviewed Flight, configure
secrets and owner identity, then verify fixture execution and reopening through
the hosted MCP endpoint. Keep keys out of source control and generated public
configuration.

Show the proposed resources and limits before provisioning. Prefer eligible
personal Hobby setup, retain local Docker as an alternative, and report actual
service requirements without promising free hosting. Repeated setup must recover
existing resources rather than creating duplicate deployments or Flights.

## 3. Hosted Brave and Serper adapters

Make Brave and Serper available alongside Exa in personal-cloud setup, with
execution through the Vercel gateway and MotherDuck Flights. Include provider
selection, server-side credential setup and provider-specific execution limits
in the guided onboarding flow. Keep the same adapters available locally and in
Docker.

Qualify each hosted adapter with fixtures and a small approved live run. Verify
search results, provenance, usage reporting and recovery before documenting it
as a supported hosted option.

## 4. Claude and Cursor MCP Apps

Qualify Claude first, then Cursor, using the same server and app. Cursor's
[official MCP documentation](https://cursor.com/docs/mcp) explicitly lists MCP
Apps support, checked October 15, 2026. Host support does not establish that
sourcesQL has passed its integration checks there.

For each tested host/version, verify authentication, final-table rendering,
source links, tree/Back navigation, durable corrections across reopen, tracked
expansion, refresh review and app messaging. Begin with saved data and fixtures;
use a small approved live run only where needed. Publish host-specific setup
instructions and report unsupported host capabilities explicitly.

## 5. Compact research checkpoints

Add a versioned continuation record containing the research question, SQL and
parameters, scope, selected canonical rows and fields, result and source-version
references, timestamps, pinned amendment revisions, pending jobs, failure state
and remaining work. Keep this small by referencing retained data. Full research
bundles remain the way to transfer the underlying data between installations.

An authorized agent must be able to resume from the checkpoint, resolve its
references and continue with the recorded corrections. Reauthorize every
dependency; report missing or inaccessible references rather than silently
replacing them with a new search. Recover uncertain work through its existing
request and job identities. Verify continuation across supported clients,
interrupted runs, stale revisions and export/import identity mappings.

## 6. Manual evidence-backed updates

Add an explicit Check for updates workflow that both discovers new entities and
revisits existing findings. Keep those scopes distinct: the current refresh
contract updates existing rows and does not admit new rows implicitly. Produce
a versioned change set covering additions, changed claims, contradictory
evidence and findings not observed during the check. Missing search results do
not establish that an entity or fact was deleted.

Retain the source versions and observation times behind each proposal. Apply SQL
filtering before costly semantic work where supported; revisit only affected
findings when dependencies establish that scope. Preserve earlier observations
and amendments, and require explicit review before updating accepted values.
Validate against controlled source changes before a small budgeted live check.

## Later: optional monitoring and expert feedback

Build opt-in research subscriptions after checkpoints and manual updates are
qualified. Evaluate provider change notifications or bounded polling, with
declared coverage, per-watch budgets, visible usage and pause controls. Keep
the current single-active-job and explicit queued-resume policy until a separate
scheduling policy is chosen.

Treat validated expert amendments as permissioned feedback records. Reuse beyond
the originating research set, model training and broader propagation require
their own product decisions and evaluation.
