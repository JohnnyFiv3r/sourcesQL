# Project status

sourcesQL includes a research SQL
engine, an MCP App, local Docker packaging and an optional Vercel/MotherDuck
backend. Installation is from this repository; no package release is required
by the quickstart.

## Working paths

- Research SQL with typed immutable results, retained sources and execution receipts.
- Fixture mode with no search or model credentials; opt-in live provider profiles.
- Local HTTP and stdio MCP transports, an interactive research table, separate
  corrections, linked investigations, explicit refresh review and bundle export/restore.
- Durable MotherDuck results and jobs, bounded on-demand Python Flights, cancellation
  and lost-response recovery. One active job per owner namespace; queued jobs resume explicitly.
- An owner-authenticated ChatGPT app with OAuth and enforced CSP. Saved-table
  rendering, corrections across reload, tree/Back navigation, a small live Auto
  expansion and fixture-based refresh review have been exercised.

## Checks at initial publication

The macOS/Python 3.12 suite passes **406 tests**, with **44 Linux-only skips**.
The app builds and passes **172 tests** on macOS and native ARM64 Linux Docker.
Docker passes **446 Python tests**, with **four macOS-only skips**, plus actual
HTTP/MCP, corrections, export, restart persistence and stdio checks. The README's
fixture SQL example runs against the real engine without provider calls. These
checks made no live search or model calls. See the Docker and runtime guides.

These results establish the tested execution and control paths. They do not
measure broad search recall, live semantic accuracy, a complete research workload
or comparative product quality.

## Current limits

The qualified hosted Exa profile uses Auto search excerpts and permits **two
queries and ten candidate pages per job**, with no additional fetches or model
calls. Broad discovery instructions ask for at least six diverse queries. An
agent must report when the configured profile cannot accommodate that coverage;
it must not silently shrink the task or bypass execution limits. Larger fanout
and hosted semantic processing need separately configured and qualified profiles.

Hosted setup is manual and supports one configured owner. This is not a shared
multi-tenant service. Claude rendering, fresh-adopter hosted onboarding, broad
live research quality and comparative benchmarks remain open qualification work.
Application allowances are finite reservations, not account-wide provider billing
hard stops or a guarantee of free hosting.

## Setup and references

The [next adoption priorities](docs/roadmap.md) are PyPI distribution, guided
personal-cloud setup and MCP Apps qualification in Claude and Cursor. These are
planned work; current installation and host-qualification limits still apply.

Start with the [README](README.md), [Docker guide](docs/docker.md),
[provider configuration](docs/providers.md) or [personal hosting guide](docs/vercel.md).
The [SQL reference](docs/language.md), [qualification notes](docs/qualification.md)
and [runtime qualification](docs/python-linux-qualification.md) describe execution
contracts and the scope of the recorded checks.
