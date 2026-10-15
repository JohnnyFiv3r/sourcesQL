# Python package

The `sourcesql` distribution contains the Python research engine, its command-line
interface and the public inputs for guided personal-cloud setup. The interactive
MCP App uses Node.js 24; it is prepared by setup rather than served by the Python
CLI. Local Docker remains available from the source repository.

## Install and try it

Use Python 3.12 through 3.14 on macOS or Linux. The SQL worker requires the
supported operating-system sandbox; it fails closed when isolation is unavailable.

```sh
python -m pip install sourcesql
sourcesql --store ./research-data demo --output ./research-demo
sourcesql --store ./research-data read RESULT_ID
sourcesql setup personal-cloud --help
```

Replace `RESULT_ID` with the ID printed by `demo`. The demo uses fictional local
sources, performs no live searches and needs no API credentials. `research-data`
is the durable engine store; `research-demo/bundle.json` is an export that can be
restored with `sourcesql --store ./restored import research-demo/bundle.json --no-network`.

Install `sourcesql[motherduck]` when directly using the Python MotherDuck storage
adapter. Guided hosted setup prepares the Flight's pinned dependencies itself.

## Build and verify a release

```sh
python -m pip install build twine
python -m build
python -m twine check dist/*
python tests/packaging/qualify_distributions.py --dist dist
```

Use Node.js 24 on `PATH` for the installed setup checks. The default build makes
a source distribution and then builds its wheel. Both
artifacts must install in separate clean environments outside the checkout.
Qualification runs the fixture demo, reopens its saved result, restores its
export and checks that installed personal-cloud templates can be materialized
without a source checkout. It also builds and reopens a fixture-only cloud plan
without contacting cloud accounts. No paid or live provider calls are part of this check.

The provisioning archive is generated from explicit public source inputs and
carries a file-hash manifest. It contains no credentials, operator state or
private documents. The reviewed Flight builder verifies the distribution before
creating its smaller execution wheel; only provisioning templates are omitted
from that runtime copy, and its hashes are recorded separately.

## Publish through GitHub Actions

Configure a pending or existing [PyPI trusted publisher](https://docs.pypi.org/trusted-publishers/)
with these exact fields:

| Field | Value |
| --- | --- |
| PyPI project | `sourcesql` |
| GitHub owner | `JohnnyFiv3r` |
| GitHub repository | `sourcesQL` |
| Workflow filename | `publish-pypi.yml` |
| GitHub environment | `pypi` |

Create the matching `pypi` GitHub environment, with the intended release controls.
The workflow builds and qualifies the same artifacts on Python 3.12, 3.13 and
3.14 before publishing. A manual workflow run verifies artifacts without
publishing; a matching version tag such as `v0.1.2` enables the publish job.
Publishing uses short-lived OIDC credentials and PyPI attestations rather than a
saved PyPI token. Version numbers and uploaded filenames are immutable, so check
the qualified artifact hashes before pushing the release tag.
