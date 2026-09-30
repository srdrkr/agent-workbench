# Personal pilot

## Daily use

Ask Eve a plain-language project question in the web app or the bound private Telegram conversation. Eve receives the approved brief, a compact dated progress summary, active commitments, and the question. New coding work without an existing exact candidate produces a plan. Refine it into an assignment, specify 1–10 exact files, review the current base and acceptance criteria, and approve one Claude run.

Steward supplies the configured repository, visibility, Routine, required checks and base branch. A proposal cannot change those. The current GitHub base is read during preparation and verified again before dispatch. Reviews expire after 15 minutes or earlier connection expiry. One unresolved coding job blocks another. Unknown starts are never retried automatically.

When Claude finishes, use **Confirm Claude finished**. Paste its session link if it was not recognized, verify the task marker, and confirm Finished or Stopped. Steward saves the owner observation, checks GitHub and closes the run in order. A PR, passing checks or merge alone cannot prove that the provider session stopped. There is no supported provider-read capability in the Routine trigger token.

### Assignment drafts

Tick **Draft a coding assignment I can review and edit** when you ask Eve. This uses the same single judgment call with a larger bounded output shape (`assignment_draft`). Ordinary requests keep their schema, reservation size and eval fixtures unchanged. When Eve returns a plan, it may include a draft with source references, suggested files, acceptance examples and verification steps. Steward treats all of these as untrusted:

- Source references must be IDs in the request's approved context snapshot. Sources Eve cited for the plan are added back if the draft leaves them out.
- A suggested file is used only when it is an exact relative path that the approved brief itself names, either in a brief source's text or in an approved coding candidate. Derived progress and coding results cannot establish file scope. Steward does not read the repository to check this. Anything else is shown as a flagged suggestion and is not prefilled.
- The outcome is your request, word for word. The approved text of each referenced source goes into the assignment in full, never shortened.
- If no suggested file can be verified, or the referenced context is too long for one assignment, Steward shows one scope question and offers **Prepare assignment manually**. Your original request is prefilled, all source text is available to inspect, and you choose the essential context, acceptance criteria and exact paths. This needs no additional model call, even when derived progress made the draft too large. Failed suggestions remain visible; context is never silently shortened. When Eve itself needs a missing or contradictory fact, it can ask one question (`clarify`) instead of proposing a plan. Eve is told not to ask you to reconfirm a priority the brief already settles.

**Review Eve's draft assignment** opens the existing editable form. Nothing is sent to Claude while you review or edit it, or while you prepare it. Dispatch still needs **Approve and start Claude** on the exact prepared review. **Edit assignment** on a prepared review creates a replacement. The earlier version becomes *Replaced by an edited assignment*, and its review can no longer be approved, so the approval always matches what is sent. The review shows whether your original outcome is still included, whether you edited Eve's draft, and any allowed file that the approved context does not name. An expired brief blocks drafting, preparing and approving.

Canceling an edit keeps the earlier review available. Editing is offered only for prepared owner assignments that support replacement. The original outcome is marked unchanged only when it remains verbatim at the beginning of the objective, not merely mentioned in copied context.

Fixtures and tests show how Steward handles drafts. They do not show that Eve drafts well. The existing output token cap can truncate verbose model responses; invalid output is held with its reservation retained. Model quality remains unevaluated until an authorized live evaluation.

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

The web summary and Telegram `/status` share one text (`shared/status-summary.js`). It starts with one of six states:

| State | Meaning | Next step shown |
|---|---|---|
| In progress | Eve is working on a recorded or just-submitted request, or Claude was observed running | Wait. The request does not need to be sent again. |
| Your decision needed | A proposal, a clarifying question or a PR is waiting for you | Decide, answer in a new request, or review the PR |
| Blocked | Something must be resolved first: held attempt, pause, expired brief, used-up allowance, unconfirmed coding start, unsent request, or a stalled request | The specific resolution |
| Decision recorded | Your commitment is recorded but the work is unfinished | Work on the commitment |
| Completed | Owner-reported work is done, or a recorded merged coding run is closed | The next piece of work, or ask Eve |
| Ready | Nothing has been recorded yet | Ask Eve |

The state comes from the same rule as the "Next:" text, so the two cannot disagree. The web
app displays a request you just submitted as in progress straight away, before the server
confirms it. Reloading the page shows the stored state instead. A request whose record is
older than five minutes without a result is shown as stalled. That does not prove the
provider stopped or did no work. An operator must check it.
That classification is display only and changes nothing in storage.

If a submission response and the following status check are both lost, the browser keeps
the request ID and text in session storage and shows its outcome as unknown. A successful
status read reconciles an existing record. If it finds no record, the owner can retry the
saved submission with the same ID and text, preserving server idempotency. Nothing is
resent automatically. Signing out clears the local receipt. Held records continue to
refresh so provider wait periods and stopped-task recovery controls become current.

## Legacy schema-refusal recovery

A stopped, released automatic review may have a recorded Gateway generation and HTTP 400 but no parsed error category. An operator can inspect that exact generation in the existing Gateway UI. If it explicitly reports an unsupported tool schema, the authenticated `POST /api/steward/recovery/observe-schema-rejection` route accepts the current record's `rejectionObservationHash`, request ID, matching `generationId`, observation time, `providerStatus: 400`, `reason: "unsupported_tool_schema"` and `source: "owner_provider_ui"`. A status code, zero cost, a PR or a worker report alone is insufficient. This is an owner observation, not an automatic provider read.

The observation stays separate from the original transport receipt and enables the existing failed-review acknowledgement. It does not acknowledge by itself, replay the review, resume the old grant, release a coding job, change the brief or refund its reserved allowance. Unknown deliveries and unverified successful responses remain held. Exact duplicate observations are idempotent; changed evidence needs a fresh review.
