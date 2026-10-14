# Qualification boundaries

Current status is a local developer build. Passing local tests, an MCP save and a rendered local preview do not establish live provider quality, a hosted ChatGPT/Claude loop, deployment or release.

| Evidence | What it establishes | What still needs separate proof |
| --- | --- | --- |
| AST/compiler and planner tests | Admitted SQL shapes, typed staging and refusal paths | The whole DuckDB language or live source coverage |
| Synthetic fixtures and mocked providers | Operator contracts, budgets, failure states and controlled evidence paths | General semantic accuracy, provider behavior or real billing |
| Actual macOS worker tests | Restricted relational execution, typed output and tested filesystem/network boundaries | Other operating systems or untested worker/runtime combinations |
| Engine/store/JSON-lines bridge and app tests | Immutable results, authorized references, corrections, request/review lifecycle and full-data restoration | A model host executing the user-driven loop or rendering a widget |
| Local browser preview | The observed controls, layout and navigation in that browser | ChatGPT/Claude permissions, messaging, polling and embedded rendering |
| Live qualification | Named provider/model behavior, accounting, source quality and disclosure policy under an approved budget | Broad corpus recall or untested providers/models |

## Reproducible local checks

From the project root:

```sh
uv sync --frozen
uv run pytest -q
cd apps/research
npm run build
npm test
```

The positive app tests `actual engine bridge completes 205-row SQL and app reference lifecycle` and `actual refresh query preserves explicit scoped row identity through result_ref` require the actual SQL worker. An enclosing tool sandbox can refuse `sandbox-exec` launch. Such a refusal is reported as unsupported execution; do not count it as a positive worker pass or bypass the worker restriction.

For transport/store checks that do not execute SQL, the measured research-bundle round trip uses 205 typed rows, a 100-row initial preview and a five-row last window. A correction to the final row remains separate from original data. Full export contains all 205 rows; restoration into a fresh engine namespace reconciles local result identity and preserves the app correction revision. An identical import retry preserves the same revision. These tests use actual JSON-lines bridge/store calls and MCP SDK clients, without proving a ChatGPT/Claude host turn.

The explicit refresh identity test binds authorized saved data, projects exact canonical row IDs through `row_id_column`, and verifies that the identity column is removed from the published display schema. The app checks exact tracked scope and preserves the parent until review. Its identity-only fixture has no new external evidence and is marked unverified; it does not establish freshness or truth.

The coordinator also verified actual macOS worker/isolation execution and a built wheel installed in a fresh environment outside the checkout. That installed fixture demo returned two rows, four source versions and six evidence records; the upstream memory package was not importable there. The local browser preview saved a planned-capacity correction from 500 to 480 and retained its Edited marker after reload. These are installed-engine and local-browser observations, not live or hosted-model qualification.

## Remaining qualification

Live tests need named provider/model configuration, explicit destination and private-data permissions where relevant, credentials and an owner-approved total budget. They must measure actual search/fetch/semantic behavior, usage and unresolved remote outcomes, rather than accepting mock receipts as real billing. Fixture scores and curated extraction answers do not measure live semantic quality.

Source completeness and semantic quality need a defined corpus and reference judgments. Exact supporting spans establish textual support. Composed SQL currently retains conservative input-set lineage; the app does not manufacture final-cell attribution where the engine has not established it.

Hosted qualification needs an actual user-driven expansion and refresh loop on each claimed host: durable request → host message/turn → query → request-bound save → explicit render → persisted reopen/review. A message acknowledgement is not execution, a save is not rendering, and a local browser preview is not a hosted result. Record the host/version and observed artifacts before making a host claim.

A separate locked app dependency installation builds successfully with MCP client 2.2.0 and a controlled generated-output inliner. The npm audit taken during this local check reported zero advisories; that is a time-bound dependency check, not a lasting security guarantee.

Independent store instances and two actual Node child processes test concurrent mutation conflicts: exactly one same-revision correction succeeds, one conflicts, and the accepted amendment remains. A crash-lock test verifies explicit busy and no automatic owner takeover. An owned fake bridge with a sleeping child verifies process-group cleanup on timeout. These are local concurrency/process checks.

The app's subprocess bridge currently has a synchronous 30-second deadline; timeout and response overflow terminate only its owned process group on POSIX. Long-work pending handles are not implemented there. Timeout recovery must retain the original request key and inspect its existing run, preserving uncertain remote outcomes instead of assuming permission to repeat work.

No publication, deployment or release qualification follows from these development checks. Source adaptation and the unchanged original-app baseline are recorded in [app provenance](../provenance/app-reuse.json); the integration contract is in [app integration](app-integration.md).
