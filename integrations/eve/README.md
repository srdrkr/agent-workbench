# Hosted Eve package

Use Node 24.21.0. Install with `npm ci --ignore-scripts --no-audit --no-fund`, run `npm test`, and build with `npm run build:hosted`. `VERCEL=1` selects Vercel output. Tests use synthetic local fixtures without provider credentials.

See [hosted configuration](../../docs/hosted-setup.md). The root Node 22 probe is separate. This package hosts the owner web app, approved project context, bounded model transport, Telegram adapter and optional fixed Routines connection. Coding is disabled by default.

Eve tools are disabled; a strict structured proposal does not grant application authority. Provider admission is durable and bounded. Unknown model requests remain held; budget reservation is not billed spend. Workflow/provider capture is separate from local trace settings, so approved context must be suitable for its configured destinations.
