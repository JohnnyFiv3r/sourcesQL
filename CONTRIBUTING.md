# Contributing

Open a pull request against `main`. Use fixture data for development and tests;
do not commit credentials, private research or provider account state.

Install Python 3.12 and Node 24, then run:

```sh
uv sync --locked --all-extras
uv run --frozen ruff check src tests scripts/qualify_python.py
uv run --frozen mypy src
uv run --frozen pytest -q tests hosted/flight/tests
npm ci --prefix apps/research
npm run check --prefix apps/research
node --test hosted/setup.test.mjs hosted/personal-cloud.test.mjs
```

PR CI uses no provider credentials and does not publish or deploy. Python 3.13
and 3.14 installed-artifact qualification remains part of the release workflow.

## Main branch policy

The versioned rules in `.github/rulesets/` describe the repository's active
GitHub settings. Editing these files alone does not change GitHub enforcement.

- All changes use a PR. Both `Python` and `App and onboarding` must pass from
  GitHub Actions against the current base branch.
- Resolve review conversations before merging. Squash or rebase to keep linear
  history; direct pushes, force pushes, deletion and merge commits are blocked.
- Contributor PRs need one approval, including approval after the latest
  reviewable push. New changes dismiss stale approvals.
- Repository administrators may bypass only the approval rule, through a PR.
  This lets the sole maintainer merge tested work without self-approval.
  The PR requirement, CI, conversation resolution and history protections have
  no bypass actors.

Release publishing remains a separate, artifact-qualified workflow.
