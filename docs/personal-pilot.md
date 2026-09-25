# Personal pilot

## Daily use

Ask Eve a plain-language project question in the web app or the bound private Telegram conversation. Eve receives the approved brief, a compact dated progress summary, active commitments, and the question. New coding work without an existing exact candidate produces a plan. Refine it into an assignment, specify 1–10 exact files, review the current base and acceptance criteria, and approve one Claude run.

Steward supplies the configured repository, visibility, Routine, required checks and base branch. A proposal cannot change those. The current GitHub base is read during preparation and verified again before dispatch. Reviews expire after 15 minutes or earlier connection expiry. One unresolved coding job blocks another. Unknown starts are never retried automatically.

When Claude finishes, use **Confirm Claude finished**. Paste its session link if it was not recognized, verify the task marker, and confirm Finished or Stopped. Steward saves the owner observation, checks GitHub and closes the run in order. A PR, passing checks or merge alone cannot prove that the provider session stopped. There is no supported provider-read capability in the Routine trigger token.

## Allowance and controls

**Review pilot allowance** sets a cumulative model-dollar cap (maximum $10 in this version) and total attempt limit (maximum 250). Existing reservations and attempts are retained; changing the brief does not reset either. No automatic top-up, provider fallback or Claude paid overage is enabled. The amount shown is conservatively reserved allowance, not billed cost.

Pause prevents new admission. It does not cancel work already running remotely. Resume requires resolving held model work and active coding first. If the model was never admitted, the request is **Not sent**, with no new reservation. A late attempt cannot then admit itself; submit a new question after fixing allowance or context size. If an external call began, uncertainty remains held for explicit review.

## Durable context

The approved brief remains separate from progress. Project notes and a current priority are owner-authored, explicitly saved for Eve. Priorities persist until replaced. Approved commitments can be marked complete, labeled as owner reports. Coding records preserve provider observations, GitHub PR/check/merge evidence and the last verified tested draft snapshot.

Inference receives a bounded projection, not the full event log: current priority, recent notes, active commitments first, and recent coding jobs. It labels dates and provenance and trims the serialized summary to 3,800 characters. Full records remain in storage. The same project keeps memory across brief revisions; other project identities are excluded. Briefs still need periodic owner refresh. A merged PR is not deployment evidence. Repository indexing, arbitrary document retrieval and automatic rewriting of the approved brief are not implemented.

## Quiet follow-up

The `Steward progress` GitHub Actions workflow calls `/api/progress` on a nominal 15-minute schedule and after CI. GitHub schedules can be delayed. It uses no checkout and executes no PR content. Configure `STEWARD_ORIGIN` and `STEWARD_MONITOR_SECRET` in the repository, and the same secret as `WORKBENCH_MONITOR_SECRET` in the host.

The endpoint accepts only an authenticated POST and chooses a known job from server state; callers cannot supply URLs, repositories or tasks. It checks at most one eligible job per ten-minute admission window, within 14 days of dispatch. Merged jobs stop polling. Meaningful result fingerprints drive Telegram notifications; unchanged results are quiet. A crash after saving GitHub evidence does not lose notification eligibility. Send intent is saved before Telegram I/O; uncertain deliveries are displayed and never automatically repeated. Provider failures retain the previous evidence.

This workflow needs to be on the default branch and secrets configured before automatic follow-up is live. With follow-through disabled, the endpoint cannot call a model, dispatch coding, release a coding job, merge or deploy. The optional [bounded follow-through](bounded-follow-through.md) adds task-authorized reviews and at most two correction sessions, with separate activation flags and a verified provider-exit gate. It never merges or deploys.

## Connection setup

Keep the existing fixed connection configuration and token. After reviewing and saving the reusable [Routine prompt](routine-prompt.md), set `WORKBENCH_CODING_REPEATABLE=yes`. Keep `WORKBENCH_CODING_OVERAGE_DISABLED=yes`, the verified-until date, API-only trigger, repository, isolated environment and trusted required checks current. Never enable repeatable mode while the remote Routine still contains the old single-task instructions.

## Pilot evidence

Local regression tests cover accounting preservation, stale approvals, memory isolation, assignment scope, single dispatch, monitor crash recovery and notification deduplication. They do not establish general model quality. During the owner pilot, record whether Eve chose a useful next action, which interventions were needed, and whether the resulting change satisfied its acceptance criteria. SMS, more bots and a coordinator follow that learning loop.

## Status summary states

The web summary and Telegram `/status` share one text (`shared/status-summary.js`). It starts with one of five states:

| State | Meaning | Next step shown |
|---|---|---|
| In progress | Eve is working on a recorded or just-submitted request, or Claude was observed running | Wait. The request does not need to be sent again. |
| Your decision needed | A proposal, a clarifying question or a PR is waiting for you | Decide, answer in a new request, or review the PR |
| Blocked | Something must be resolved first: held attempt, pause, expired brief, used-up allowance, unconfirmed coding start, unsent request, or a stalled request | The specific resolution |
| Completed / Decision recorded | Your decision is recorded or owner-reported work is done. A commitment is never described as done work. | The next piece of work, or ask Eve |
| Ready | Nothing has been recorded yet | Ask Eve |

The state comes from the same rule as the "Next:" text, so the two cannot disagree. The web
app displays a request you just submitted as in progress straight away, before the server
confirms it. Reloading the page shows the stored state instead. A request whose record is
older than five minutes without a result is shown as stalled: the hosted function stops
after 90 seconds, so it ended without recording an outcome. An operator must check it.
That classification is display only and changes nothing in storage.
