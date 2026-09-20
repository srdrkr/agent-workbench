# Agent Workbench

## Read first

Read `README.md`, `docs/handoff.md`, and the relevant parts of `docs/build-plan.md`. The plan in this repository is authoritative for product direction; no private planning workspace is required.

## Settled direction

- Project Steward first, including project judgment, follow-through, and simple conversational input.
- Eve hosts the steward. Anthropic-hosted Claude Code, triggered through Routines, is its coding partner using subscription allowance.
- Do not build a hosted coding CLI, credential proxy, or automatic paid API fallback.
- One active learning effort, with practical evals, observability, and owner-led failure analysis. Additional bots and a coordinator come after the first useful loop.
- One repository may contain shared application code and multiple bot definitions. Enforce bot/project authorization and private-state isolation at runtime; directory separation is not isolation.

## Current setup

Documentation only. No package manager, install/dev/test/build commands, CI, deployment, or remote is configured. Establish and document real commands when adding the first executable slice; do not claim unrun checks passed.

## Development and authority

- Preserve existing work. Use an implementation branch/worktree; keep one writer per target. Use conventional commits.
- Scale checks to the change. Obtain independent review for behavioral code, prompts, or instructions; correct concrete findings without open-ended review loops.
- Keep merges, external publication, deployment, credentials/account changes, and live provider actions within explicit owner authorization. Completing local preparation does not require another approval.
- Treat proposed budgets as unapproved until confirmed. Never silently enable paid overage or change providers.
- Never commit secrets, raw private context, or unredacted runtime traces. Prefer synthetic fixtures. Do not put trigger credentials in task payloads or repository-executed environments.
- A timed-out routine dispatch may have started a session. Persist intent and reconcile; never blindly retry. Stop-requested is not confirmed stopped.
- Record provider observations separately from worker self-reports. Do not invent cancellation, transcript, version-pinning, or resume capabilities.
- Keep instructions compact and grounded in this repo. Propose changes to settled direction for the owner; do not silently expand scope.
