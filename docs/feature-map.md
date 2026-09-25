# Feature map — Project Steward (Eve)

Generated **2026-09-24** (America/Phoenix, MST) for local branch `grok/request-status-browser-verifier` based on main `342070c0e3c2e09205f4c8df38b3eb7f63644772`.

Legend:
- **Controller / unit:** existing `node:test` suites under `test/` and `integrations/eve/test/`.
- **Browser-verified (this slice):** `npm run verify:request-status` → `integrations/eve/scripts/request-status-verifier.js` (Playwright against real `hostedHandler` + Nuxt SPA client; synthetic judge only).
- **Deferred browser:** not covered by the browser verifier in this slice.

| Area | User intent | Entry point | Required state | Expected result | Code | Checks / evidence |
|---|---|---|---|---|---|---|
| **Request / status** | Ask Eve a project question; see in-progress then a proposal (or held) with a next owner action | Web: login → textarea `#request` → **Ask Eve**; `POST /api/steward/propose`; `GET /api/steward/state`; status via `statusSummary` | Owner session; fresh brief; not paused; budget remaining | Notice *Eve is considering…* while busy; then `awaiting_approval` + **Approve commitment**, or `held` + **Refresh status** / blocked notice. No silent approve/coding completion. | `app/app.vue`, `hosted/http.js`, `hosted/steward.js`, `shared/status-summary.js` | **Browser-verified:** `npm run verify:request-status` scenarios `start-finish-request`, `blocked-request` (screenshots + `report.json`). **Controller:** `test/hosted.test.js`, `status-summary.test.js`, root `steward*.test.js`. |
| **Project context** | Preview/apply an owner brief revision | Web brief form → `POST /api/steward/context/preview\|apply` | No unresolved thinking/held/active coding (per rules) | New revision; history retained; stale approvals unusable | `hosted/context.js`, `app/app.vue` | **Controller:** `connection.test.js` context cases. **Deferred browser.** |
| **Assignment approval** | Approve a commitment or prepare/approve a coding assignment | **Approve commitment**; coding prepare/review/approve APIs | Matching hashes; coding config when coding | Durable commitment **or** coding intent before fire | `steward.approve`, `hosted/coding.js` | **Controller:** `connection.test.js`, `pilot.test.js`, root `steward.test.js`. **Deferred browser** (coding out of scope for this verifier). |
| **Assignment drafting** | Turn a short request into an editable, reviewable coding assignment without operator drafting | Web: tick **Draft a coding assignment…** → **Ask Eve** (`mode: assignment_draft`) → **Review Eve’s draft assignment** → **Prepare exact review** → **Edit assignment** / **Approve and start Claude** | Pilot approved; repeatable coding configured; fresh brief | One judge call; draft validated against approved context (flags, one gap question); edits supersede earlier reviews; exactly one Routine fire only after exact approval | `hosted/assignment-draft.js`, `hosted/coding.js` (`prepare` supersedes), `hosted/steward.js`, `schema.js` (`draftProposalSchema`), `app/app.vue` | Unit: `test/assignment-draft.test.js`. **Browser-verified:** `assignment-draft-edit-approve`, `assignment-draft-gap`, `assignment-draft-invalid-path`, `assignment-draft-stale` (synthetic coding connection: in-process Routine recorder, static GitHub reader). Model drafting quality: **not evaluated** (needs authorized live eval) |
| **Coding result** | Observe draft PR / checks after Claude; close run | Coding cards; reconcile/observe/release; `/api/progress` | Dispatch receipt + GitHub evidence; provider exit before release | `tested_draft_pr` etc.; never claim merge/deploy from PR alone | `hosted/coding.js`, `src/providers.js`, `hosted/monitor.js` | **Controller:** connection evidence/release; `probe.test.js`. **Deferred browser.** |
| **Blocked follow-through** | Autonomous review/correction stops with a reason | Progress wakeup / `FollowThrough.run` (flags off by default) | Follow-through grant + limits | `follow_through_*` events; blocked reason; no blind retry | `hosted/follow-through.js`, `code-review.js` | **Controller:** `follow-through.test.js`. **Deferred browser.** |

## Verifier command

```sh
cd integrations/eve
npm run verify:request-status -- --evidence /path/to/evidence
```

Optional: `--netns` re-executes verification under `unshare -rn` (when available) after setup downloads.

Default `npm test` remains `node --test test/*.test.js` and does **not** load `verification/` or Playwright.
