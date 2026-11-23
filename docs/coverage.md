# Measuring coverage

Two commands print per-module line and branch coverage, then the list of files
coverage cannot measure. Neither command has a threshold: a low figure is
printed and never fails a run. The figures are a baseline, not a gate. Two runs
on the same commit should agree within about one point.

| Suite | Command, from the repository root | Reports written |
|---|---|---|
| Python engine and Flight | `uv run --frozen python scripts/coverage_python.py` | `coverage/python/index.html`, `coverage/python/coverage.json` |
| Research app | `npm run build --prefix apps/research && npm run coverage --prefix apps/research` | `apps/research/coverage/index.html`, `apps/research/coverage/coverage-summary.json`, plus `lcov.info` and `summary.txt` |

The app command needs the same `SOURCESQL_PYTHON` as `npm test`, and the build first: some tests start the built app, and fail without `apps/research/dist`.

## Not measured

Coverage traces one process. Code that only runs in a child process, or that no
test loads, shows 0% or is missing from the tables. That means not measured,
not untested. Each line below is `path | checked by`; both commands print this
list from here, and `tests/unit/test_coverage_docs.py` checks that every named
file exists.

```not-measured
src/sourcesql/execution/linux_sandbox.py | tests/security/test_linux_worker_isolation.py
src/sourcesql/execution/linux_syscalls.py | tests/security/test_linux_worker_isolation.py
src/sourcesql/bridge.py | apps/research/tests/sourcesql.test.ts (its JSON-lines bridge tests start the real bridge)
src/sourcesql/execution/worker_process.py | tests/integration/test_engine_plans.py (its actual-worker test starts the real worker loop)
hosted/flight/runner.py | no automated check of the main entrypoint (hosted/flight/tests/test_runner_validation.py runs its validation functions in-process)
apps/research/src/app.tsx | no automated check; manual browser QA at release
```

`hosted/flight/runner.py` is partly measured: its validation functions run in
the test process, and its `main` entrypoint does not. The sandbox and syscall
filter are checked by behavioural isolation tests that run on Linux only. The
macOS sandbox check, `tests/security/test_worker_isolation.py`, is skipped on
Linux.
