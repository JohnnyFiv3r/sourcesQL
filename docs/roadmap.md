# Next adoption work

These are the next implementation priorities. They are planned work, not current
installation instructions or additional qualified host claims.

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
