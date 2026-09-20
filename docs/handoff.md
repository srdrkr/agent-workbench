# Development handoff

Read README.md, docs/build-plan.md and docs/current-work.md. The public snapshot includes application source and synthetic tests, not production credentials or operational records.

Root tests use Node 22.22.0. Hosted tests/build use Node 24.21.0 and a lockfile-based install with lifecycle scripts disabled. CI jobs are `root-checks` and `hosted-checks`. Keep required checks intact.

Use one writer per target and obtain independent review for behavior or authority changes. Preserve existing work. Do not treat a source file, task candidate or provider self-report as approval or verified execution. Live actions need the scoped owner-approved configuration outside this repository.

First assignment: decisions history presentation in docs/current-work.md. Its coding partner should return a draft PR with exact checks and commit evidence. Owner merge and deployment follow separately.
