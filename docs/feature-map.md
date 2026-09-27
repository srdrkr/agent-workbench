# Feature map — Project Steward (Eve)

Generated **2026-09-24** (America/Phoenix, MST) for local branch `grok/request-status-browser-verifier` based on main `342070c0e3c2e09205f4c8df38b3eb7f63644772`. Held-attempt recovery row added **2026-09-25** on `grok/held-request-recovery`.

Legend:
- **Controller / unit:** existing `node:test` suites under `test/` and `integrations/eve/test/`.
- **Browser-verified (this slice):** `npm run verify:request-status` → `integrations/eve/scripts/request-status-verifier.js` (Playwright against real `hostedHandler` + Nuxt SPA client; synthetic judge only).
- **Deferred browser:** not covered by the browser verifier in this slice.

| Area | User intent | Entry point | Required state | Expected result | Code | Checks / evidence |
|---|---|---|---|---|---|---|
| **Request / status** | Ask Eve a project question; see in-progress then a proposal (or held) with a next owner action | Web: login → textarea `#request` → **Ask Eve**; `POST /api/steward/propose`; `GET /api/steward/state`; status via `statusSummary` | Owner session; fresh brief; not paused; budget remaining | Notice *Eve is considering…* while busy; then `awaiting_approval` + **Approve commitment**, or `held` + **Refresh status** / blocked notice. No silent approve/coding completion. | `app/app.vue`, `hosted/http.js`, `hosted/steward.js`, `shared/status-summary.js` | **Browser-verified:** `npm run verify:request-status` scenarios `start-finish-request`, `blocked-request` (screenshots + `report.json`). **Controller:** `test/hosted.test.js`, `status-summary.test.js`, root `steward*.test.js`. |
| **Held attempt recovery** | Understand a held model attempt and take the one safe next step | Handoff block on each held record; **Acknowledge failed review** only for a confirmed provider refusal of a coding review; then **Start a fresh request**. `POST /api/steward/recovery/acknowledge` | Owner session; held `coding_review` with a consistent status/category refusal; task follow-through stopped | Five cases shown distinctly; acknowledgement persists, keeps the provider record/reservation/task history, sends no model or Routine request, is idempotent; uncertain/unverified/unclassified stay held with the missing evidence named | `hosted/recovery.js`, `hosted/steward.js`, `hosted/http.js`, `app/app.vue` | **Browser-verified:** scenarios `held-rejected-review-recovery`, `held-uncertain-review-blocked`. **Controller:** `test/recovery.test.js` (synthetic task via `test/held-review-fixture.js`). Docs: `docs/bounded-follow-through.md`. |
| **Project context** | Preview/apply an owner brief revision | Web brief form → `POST /api/steward/context/preview\|apply` | No unresolved thinking/held/active coding (per rules) | New revision; history retained; stale approvals unusable | `hosted/context.js`, `app/app.vue` | **Controller:** `connection.test.js` context cases. **Deferred browser.** |
| **Assignment approval** | Approve a commitment or prepare/approve a coding assignment | **Approve commitment**; coding prepare/review/approve APIs | Matching hashes; coding config when coding | Durable commitment **or** coding intent before fire | `steward.approve`, `hosted/coding.js` | **Controller:** `connection.test.js`, `pilot.test.js`, root `steward.test.js`. **Deferred browser** (coding out of scope for this verifier). |
| **Coding result** | Observe draft PR / checks after Claude; close run | Coding cards; reconcile/observe/release; `/api/progress` | Dispatch receipt + GitHub evidence; provider exit before release | `tested_draft_pr` etc.; never claim merge/deploy from PR alone | `hosted/coding.js`, `src/providers.js`, `hosted/monitor.js` | **Controller:** connection evidence/release; `probe.test.js`. **Deferred browser.** |
| **Blocked follow-through** | Autonomous review/correction stops with a reason | Progress wakeup / `FollowThrough.run` (flags off by default) | Follow-through grant + limits | `follow_through_*` events; blocked reason; no blind retry | `hosted/follow-through.js`, `code-review.js` | **Controller:** `follow-through.test.js`. **Deferred browser.** |

## Verifier command

```sh
cd integrations/eve
npm run verify:request-status -- --evidence /path/to/evidence
```

Optional: `--netns` re-executes verification under `unshare -rn` (when available) after setup downloads.

Default `npm test` remains `node --test test/*.test.js` and does **not** load `verification/` or Playwright.
