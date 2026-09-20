# Agent Workbench

Project Steward is a personal project assistant hosted with Eve. It uses an owner-approved brief to propose useful next steps, records explicit decisions, and commissions bounded coding work through Anthropic-hosted Claude Code.

## What works

- Owner-authenticated web workspace with PostgreSQL persistence.
- Sourced proposals, explicit commitment approval, and owner-only Telegram input.
- Versioned project brief preview/approval with preserved history and model accounting.
- Exact coding review, durable single dispatch through Claude Routines, and independent GitHub PR/check evidence.

The coding connection is off by default. A model response or Telegram message cannot grant coding authority. Unknown dispatch outcomes stay unknown and are not retried automatically. Merge and deployment remain owner actions.

## Run locally

The root package is a dependency-free local probe and synthetic Steward demo. Use Node 22.22.0:

```sh
npm test
npm run check
npm run steward
# Another terminal:
npm run steward:open
```

The hosted application is in `integrations/eve`, with Node 24.21.0:

```sh
cd integrations/eve
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build:hosted
```

The test suites use synthetic fixtures and local mock servers. Do not add real credentials to test commands or CI. See [architecture and boundaries](docs/build-plan.md), [current work](docs/current-work.md), [handoff](docs/handoff.md), and [hosted configuration](docs/hosted-setup.md).

## Architecture

Owner web / Telegram → Eve Project Steward → approved Claude Routine → hosted Claude Code → draft PR and GitHub checks.

Steward inference and hosted coding have separate accounting: inference uses a bounded Gateway allowance; coding uses Claude subscription allowance with paid overage disabled. Persistent project state, sessions, tokens and raw traces stay outside this public repository.

## Verification and limits

The publication baseline passed 44 root tests and 53 hosted tests, independent review and a Vercel-output build. These establish local behavior, not general model quality or complete remote cancellation. CI repeats both suites and the hosted build. The first application coding run is pending; earlier synthetic experiments are not application completion evidence.

GitHub evidence is refreshed explicitly. Provider termination observations remain manual. No unattended result polling, paid fallback, automatic merge or automatic deployment is implemented. The repository instructions' original “Documentation only” setup paragraph is historical; the commands above are current.

This public repository begins with a reviewed source snapshot. Private operational records and earlier local development history are intentionally excluded. A public synthetic experiment fixture and demo link remain as explicitly labeled historical examples, not live application results.
