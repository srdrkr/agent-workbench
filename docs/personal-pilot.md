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

This workflow needs to be on the default branch and secrets configured before automatic follow-up is live. The endpoint cannot call a model, dispatch coding, release a coding job, merge or deploy.

## Connection setup

Keep the existing fixed connection configuration and token. After reviewing and saving the reusable [Routine prompt](routine-prompt.md), set `WORKBENCH_CODING_REPEATABLE=yes`. Keep `WORKBENCH_CODING_OVERAGE_DISABLED=yes`, the verified-until date, API-only trigger, repository, isolated environment and trusted required checks current. Never enable repeatable mode while the remote Routine still contains the old single-task instructions.

## Pilot evidence

Local regression tests cover accounting preservation, stale approvals, memory isolation, assignment scope, single dispatch, monitor crash recovery and notification deduplication. They do not establish general model quality. During the owner pilot, record whether Eve chose a useful next action, which interventions were needed, and whether the resulting change satisfied its acceptance criteria. SMS, more bots and a coordinator follow that learning loop.
