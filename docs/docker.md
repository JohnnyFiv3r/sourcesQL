# Local Docker app and engine

Docker packages the sourcesQL research workspace, MCP server and Python engine.
Fictional fixture providers are the default. The browser endpoint binds only to
your computer's loopback interface; the stdio MCP service needs no network.

The images pin Python 3.12.14 and official Node 24.21.0 image digests, use the
exact Python/npm lock versions, and install sourcesQL as a package. The app
runtime contains compiled JavaScript and production Node dependencies, with no
npm, TypeScript compiler or `tsx` loader. Public dependency downloads need
internet during the build and use a reusable BuildKit cache; fixture execution
needs none.

## Browser workspace

From the repository root, with an existing Docker daemon running:

```sh
docker compose up --build -d sourcesql-app
```

Open [the local workspace](http://127.0.0.1:3117). The MCP endpoint is
`http://127.0.0.1:3117/mcp`. The default browser workspace is anonymous fixture
mode and accepts only fixture provider profiles. The HTTP gateway uses a normal
Docker bridge for loopback publishing and can access the network; its SQL worker
still denies networking independently. Host and cross-origin guards remain
enabled inside the app. No provider credentials are forwarded by Compose.

The named `sourcesql-app-data` volume keeps engine results, saved tables,
separate corrections and published UI bundles across container restarts:

```sh
docker compose restart sourcesql-app
```

If port 3117 is already in use, set `SOURCESQL_HTTP_PORT` before starting Compose.
The published and internal port change together so the app's origin checks
remain correct.

## MCP over stdio

Build the app image without starting a browser server:

```sh
docker compose build sourcesql-mcp
```

Then add this entry to your MCP client's configuration.
Replace the absolute Compose file path with your checkout path:

```json
{
  "mcpServers": {
    "sourcesql-research": {
      "command": "docker",
      "args": [
        "compose", "-f", "/absolute/path/sourcesql/compose.yaml",
        "run", "--rm", "-T", "--no-deps", "sourcesql-mcp"
      ]
    }
  }
}
```

This runs the compiled MCP server with machine-only stdout, no TTY and no
network. The MCP workspace belongs to the trusted `local-owner` principal; the
browser's anonymous fixture workspace remains separate by default. Both keep
their state in the named app volume. No host Python or Node installation is
needed to use either Docker service.

## Headless CLI

From the repository root, with an existing Docker daemon running:

```sh
docker compose build sourcesql
docker compose run --rm sourcesql
docker compose run --rm sourcesql query --sql 'SELECT CAST(1 AS BIGINT) AS value'
docker compose run --rm sourcesql capabilities --json
```

The separate `sourcesql-data` volume preserves CLI results and the demo bundle.
All services run as UID 10001, drop capabilities, enable
`no-new-privileges`, use Docker's default seccomp policy, have a read-only image,
and keep writable state in named volumes plus temporary scratch space. No
provider credentials, host directories or Docker socket are forwarded.
The engine's Linux worker restrictions are also applied inside the container.
If required kernel isolation is unavailable, SQL execution refuses to run.

The default configuration uses fixture behavior; it is not a live-provider setup.
Live research would need explicit provider configuration, network access for the
parent process, and an approved budget. The relational worker must continue to
deny network and provider credentials independently of container settings.

## Reproduce Linux qualification

```sh
bash scripts/qualify-linux.sh
bash scripts/qualify-docker-app.sh
```

The harness builds separate runtime and qualification images, runs the complete
Python fixture suite with networking disabled, and runs the installed runtime
demo. It mounts a readable synthetic sentinel outside the worker allowlist and
injects a synthetic environment value into the parent; Linux security tests must
prove the worker cannot read or inherit them. Receipts under `artifacts/` include
image identity, Docker/kernel environment, test output and the installed demo.

The app harness also builds the standalone UI and compiled server, runs the full
Node and Python suites in the same image against the actual Linux worker, and
checks HTTP/MCP query, corrections,
bundle export, restart persistence, Host/origin refusal and the exact Docker
stdio command. It creates a unique synthetic Compose project and removes only
that project's containers, network and volume when finished. This developer
harness requires host Python 3; ordinary Docker adoption does not.

The build context explicitly includes engine/app source, tests, examples,
dependency metadata and public assets/license/readme files. It excludes the private
handoff, local operator data, artifacts, environment files, cloud spikes, Git
metadata and app dependencies. Never relax seccomp, add privileged mode, or
mount the Docker socket to make worker qualification pass.

Passing on one Docker kernel and architecture establishes that measured runtime
only. MotherDuck Flight isolation must be tested separately in its actual
runtime; Docker qualification does not establish hosted execution or billing.

## Measured local qualification

On October 14, 2026, the updated combined app image passed all **102 Node tests** and
**355 Python tests**, including all **44 Linux isolation cases** and **37 offline
Flight Exa-policy cases**. Four macOS-only
Python tests were skipped; no Node tests were skipped. The one
warning was an existing Pydantic Graph event-loop deprecation. The measured
environment was Python **3.12.14**, native Linux **aarch64**, kernel
**6.12.76-linuxkit**, UID **10001**, with Landlock ABI **6** and Docker's default
seccomp policy retained. The test container had no network, privileges or added
capabilities; mounted-file and environment sentinels were inaccessible to the
worker. Installed dependency versions matched the lock.

The production app completed a real two-row fixture query over HTTP/MCP, served
its versioned UI resource, appended a correction from 500 to 480 without changing
the original value, and exported the complete research bundle. A container
restart reopened the same table and correction from the named volume. The exact
Docker stdio command exposed 27 tools and completed an actual engine query.
Host/origin refusal, loopback-only publication and container restrictions passed.

Combined receipts, immutable image IDs and matching before/after source hashes
are in `artifacts/docker-app-20261014T200343Z/`. For this app-only comparison fix,
the 355-test Python result is reused from `artifacts/docker-app-20261014T191504Z/`
after checking identical Python/test source, dependency pins, Docker recipe and
runtime. The full Node suite and production HTTP/stdio lifecycle were rerun on
the new image. Earlier CLI-only demo and Compose
persistence receipts remain in `artifacts/linux-py312-20261014T163438Z/` and
`artifacts/linux-py312-20261014T160208Z/`. Receipts remain operator artifacts
rather than public package contents. No live provider or cloud calls were made
for these local checks. All synthetic qualification containers and volumes were
removed; existing adopter data was preserved. The
[actual MotherDuck x86-64 runtime](python-linux-qualification.md) passes its
separate installed-engine and 44-case Linux qualification. Native x86-64
Docker packaging remains a separate runtime measurement.
