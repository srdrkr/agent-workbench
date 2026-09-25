import { followThroughNotice } from './follow-through-notice.js';
/**
 * One short project-status summary shared by Telegram and the web view.
 *
 * It reads the steward view (`steward.view()` / `GET /api/steward/state`) and
 * returns plain text of at most 280 characters, including an optional link.
 * Only recorded evidence is used: GitHub observations, owner-observed Claude
 * session state, owner-reported commitments, saved notes, request status and
 * pilot limits. Nothing here reads or writes storage, and nothing is presented
 * as more certain than the record supports: a draft PR is not a merge, a merge
 * is not a deployment, a GitHub result never proves the Claude session ended,
 * and "working" is only said when the owner recorded the session as running.
 *
 * Owner state: every Next branch also names one state, so the state and the next
 * step can never disagree: working (a recorded request or observed session is in
 * progress), awaiting_decision, blocked, completed, or ready (nothing recorded).
 */
export const STATUS_SUMMARY_LIMIT = 280;
// A hosted request cannot outlive its function limit (90 s). A thinking record older
// than this has stopped without recording an outcome; it is shown as stalled, never
// as still working. Display only: the record itself is not changed.
export const STALLED_AFTER_MS = 5 * 60_000;
export const OWNER_STATES = Object.freeze({ working: 'In progress', awaiting_decision: 'Your decision needed', blocked: 'Blocked', completed: 'Completed', ready: 'Ready' });
const MIN_DETAIL = 24;

const clip = (text, max) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (max <= 0) return '';
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
};
const latest = (items, key) => [...items].sort((a, b) => String(b[key] ?? '').localeCompare(String(a[key] ?? '')))[0] ?? null;
const list = value => (Array.isArray(value) ? value.filter(v => v && typeof v === 'object') : []);
const usd = micros => `$${(micros / 1e6).toFixed(2)}`;

const GITHUB = {
  merged_pr: 'PR merged; deployment not verified',
  tested_draft_pr: 'draft PR passed required checks',
  needs_review: 'PR open; checks or review pending',
  branch_without_pr: 'branch pushed; no PR yet',
  conflicting_prs: 'several PRs match one task; needs review',
  not_found: 'no GitHub result recorded yet',
};
const UNMERGED = ['tested_draft_pr', 'needs_review', 'branch_without_pr', 'conflicting_prs'];
// Outcome-1 follow-up: a held record may carry the server's recovery classification
// (hosted/recovery.js). Only its case, action and who-acts fields are used here.
const HELD_CASE = {
  confirmed_rejection: 'provider refused a held attempt',
  expired_authority: 'provider refused a held attempt; its authority expired',
  allowance_exhausted: 'provider refused a held attempt; allowance exhausted',
  uncertain_delivery: 'held attempt outcome unknown',
  unverified_output: 'held attempt output not verified',
  unclassified: 'held attempt cannot be classified safely',
};
function heldNext(held) {
  const r = held.recovery;
  if (!r) return 'review the held attempt';
  if (r.action === 'acknowledge') return 'acknowledge the failed review in the web app, then start a fresh request';
  if (held.retryReviewHash) return 'retry the refused request once in the web app';
  if (r.case === 'uncertain_delivery') return 'operator: check provider usage for the held attempt; do not resend';
  if (/follow-through/i.test(r.whoActs ?? '')) return 'wait for follow-through to stop the task, then acknowledge';
  if (/operator/i.test(r.whoActs ?? '')) return 'operator: check the held attempt; do not resend';
  return 'review the held attempt';
}
const CONTINUATION = {
  CONTINUATION_CONTEXT_CHANGED: 'brief changed after the follow-up was approved',
  CONTINUATION_SOURCE_EXPIRED: 'reviewed coding result expired',
  CONTINUATION_UNAVAILABLE: 'coding run must close before continuing',
};

function facts(view, options = {}) {
  const v = view && typeof view === 'object' ? view : {};
  const nowMs = Date.parse(options.now ?? v.observedAt ?? '');
  const revision = v.project?.revision;
  const current = list(v.requests).filter(r => !r.contextRevision || revision === undefined || r.contextRevision === revision);
  // The progress view is already scoped to the active project by the application,
  // so an empty list there is authoritative. Only a view without it falls back to
  // the unscoped lists, and then only to records of the same project.
  const scoped = (progressList, fallback) => (v.progress && typeof v.progress === 'object' ? list(progressList)
    : list(fallback).filter(item => item.projectId === undefined || v.project?.id === undefined || item.projectId === v.project.id));
  const jobs = scoped(v.progress?.jobs, v.codingJobs);
  const commitments = scoped(v.progress?.commitments, v.commitments);
  const job = latest(jobs, 'dispatchStartedAt');
  // dispatch: routine receipt ('unknown' until observed; 'accepted', 'rejected', 'usage_limited').
  // execution: owner-observed session state ('unobserved', 'running', 'exited', 'stopped').
  const dispatch = job?.dispatch; const execution = job?.execution;
  const failedStart = ['rejected', 'usage_limited'].includes(dispatch);
  const held = current.find(r => r.status === 'held') ?? null;
  const pending = current.find(r => r.status === 'thinking') ?? null;
  // A local (not yet refreshed) submission is never stalled; a recorded one is judged by server time.
  const stalled = pending && requestStalled(pending, Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : undefined) ? pending : null;
  const thinking = stalled ? null : pending;
  const newest = latest(current, 'createdAt');
  const jobOpen = Boolean(job && !job.releasedAt && !failedStart);
  return {
    v, job, held, thinking, stalled, jobOpen, failedStart,
    needsContext: newest?.status === 'needs_context' ? newest : null,
    notSent: newest?.status === 'not_sent' ? newest : null,
    acknowledged: newest?.status === 'rejection_acknowledged' ? newest : null,
    startUnconfirmed: jobOpen && dispatch !== 'accepted' && !['running', 'exited', 'stopped'].includes(execution),
    running: jobOpen && execution === 'running',
    ended: jobOpen && ['exited', 'stopped'].includes(execution),
    awaiting: current.find(r => r.status === 'awaiting_approval' && r.proposal) ?? null,
    done: latest(commitments.filter(c => c.completedAt), 'completedAt'),
    open: latest(commitments.filter(c => !c.completedAt), 'approvedAt'),
    note: list(v.progress?.notes).find(n => n.kind !== 'priority') ?? null,
    priority: v.progress?.priority ?? null,
    // Cumulative dollar reservations and the request count are separate limits. Both are read only.
    dollarsExhausted: Number.isFinite(v.budgetMicros) && Number.isFinite(v.reservedMicros) && v.reservedMicros >= v.budgetMicros,
    attemptsExhausted: Number.isFinite(v.providerAttempts) && Number.isFinite(v.maxProviderAttempts) && v.providerAttempts >= v.maxProviderAttempts,
  };
}

// Each part is [fixed text, detail]; the detail is the only piece that shrinks.
function progress({ job, jobOpen, failedStart, startUnconfirmed, running, ended, done, open, note }) {
  if (job) {
    const result = job.result?.result;
    const objective = job.spec?.objective;
    if (failedStart) return [result ? `${GITHUB[result] ?? 'GitHub result needs review'}; Claude could not start` : 'Claude could not start: ', result ? '' : objective];
    if (!jobOpen) {
      if (!result || result === 'not_found') return ['coding run closed without a GitHub result: ', objective];
      if (result === 'merged_pr') return [GITHUB[result], ''];
      return [`${GITHUB[result] ?? 'GitHub result needs review'}; run closed, ${result === 'branch_without_pr' ? 'no PR' : 'PR not merged'}`, ''];
    }
    const session = running ? 'Claude observed running' : ended ? 'Claude ended, run not closed' : startUnconfirmed ? 'Claude start unconfirmed' : 'Claude finish unconfirmed';
    if (result) return [`${GITHUB[result] ?? 'GitHub result needs review'}; ${session}`, ''];
    if (startUnconfirmed) return ['Claude start unconfirmed for: ', objective];
    return [`${running ? 'Claude observed running' : ended ? 'Claude ended' : 'sent to Claude'}, no GitHub result yet: `, objective];
  }
  if (done) return ['owner reported done: ', done.title];
  if (open) return ['committed, not yet done: ', open.title];
  if (note) return ['latest note: ', note.text];
  return ['no recorded progress yet', ''];
}

function blocker({ v, held, thinking, stalled, job, jobOpen, failedStart, startUnconfirmed, notSent, dollarsExhausted, attemptsExhausted }) {
  if (v.continuationProblem) return [CONTINUATION[v.continuationProblem] ?? 'continuation needs operator review', ''];
  if (v.paused) return ['new model requests paused', ''];
  if (v.contextFresh === false) return ['project brief expired', ''];
  if (dollarsExhausted) return [`model allowance used up (${usd(v.reservedMicros)} of ${usd(v.budgetMicros)} reserved)`, ''];
  if (attemptsExhausted) return [`request limit reached (${v.providerAttempts} of ${v.maxProviderAttempts} attempts)`, ''];
  if (stalled) return ['no result recorded from Eve; outcome unknown', ''];
  if (held) return [HELD_CASE[held.recovery?.case] ?? 'a held model attempt needs review', ''];
  if (startUnconfirmed) return ['coding start unconfirmed; check Claude first', ''];
  if (failedStart && !job.releasedAt) return [job.dispatch === 'usage_limited' ? 'Claude usage limit; coding did not start' : 'coding dispatch rejected', ''];
  if (jobOpen && job.stopRequested) return ['coding paused; stop requested, not confirmed', ''];
  if (v.monitor?.lastError) return ['GitHub check unavailable; older result shown', ''];
  if (thinking) return ['none; Eve is working on your request', ''];
  if (job?.result?.result === 'conflicting_prs') return ['several PRs match one task', ''];
  if (notSent) return ['the last request was not sent', ''];
  return ['none recorded', ''];
}

// Returns [fixed text, detail, owner state]. The state comes from the same branch as the text.
function next(f) {
  const { v, held, thinking, stalled, job, jobOpen, failedStart, startUnconfirmed, running, ended, awaiting, needsContext, notSent, open, done, priority, dollarsExhausted, attemptsExhausted } = f;
  const result = job?.result?.result;
  if (v.continuationProblem) return ['review continuation in the web app', '', 'blocked'];
  if (v.paused) {
    if (held) return ['review the held attempt before resuming', '', 'blocked'];
    if (stalled) return ['ask the operator to check the stalled request before resuming', '', 'blocked'];
    if (thinking) return ['wait for Eve before resuming', '', 'working'];
    if (jobOpen) return [ended ? 'close the coding run before resuming' : 'check Claude and close the run before resuming', '', 'blocked'];
    return ['resume requests when ready', '', 'blocked'];
  }
  // A request in progress comes first: the brief cannot change and nothing else can be admitted until it ends.
  if (thinking) return ['wait for Eve\'s answer; no need to send the request again', '', 'working'];
  if (v.contextFresh === false) return ['update the project brief', '', 'blocked'];
  if (stalled) return ['ask the operator to check the stalled request; do not resend it', '', 'blocked'];
  if (held) return [heldNext(held), '', 'blocked'];
  // An acknowledged failed review of the stopped task: the PR is still unreviewed; nothing is retried.
  if (f.acknowledged && v.followThrough?.status === 'blocked' && f.acknowledged.taskId === v.followThrough.taskId) {
    return ['review the PR yourself or start a fresh request; the failed review stays in history', '', 'awaiting_decision'];
  }
  const follow = v.followThrough && followThroughNotice(v.followThrough);
  if (follow) return ['', follow, ['blocked', 'waiting_for_connection'].includes(v.followThrough.status) ? 'blocked' : 'awaiting_decision'];
  if (jobOpen) {
    if (startUnconfirmed) return ['check Claude, then confirm or close the run', '', 'blocked'];
    if (ended) return [result === 'tested_draft_pr' ? 'close the coding run, then review the draft PR' : 'check GitHub, then close the coding run', '', 'awaiting_decision'];
    if (running) return ['wait for Claude; check GitHub later', '', 'working'];
    if (result === 'tested_draft_pr') return ['confirm Claude finished, then review the draft PR', '', 'awaiting_decision'];
    if (result === 'merged_pr') return ['confirm Claude finished and close the run', '', 'awaiting_decision'];
    if (result === 'needs_review' || result === 'conflicting_prs') return ['review the PR state, then confirm Claude finished', '', 'awaiting_decision'];
    return ['wait for GitHub progress; confirm when Claude finishes', '', 'working'];
  }
  if (job && !failedStart && UNMERGED.includes(result)) {
    return [result === 'branch_without_pr' ? 'check the pushed branch; no PR yet' : result === 'conflicting_prs' ? 'resolve the several matching PRs' : 'review the unmerged PR', '', 'awaiting_decision'];
  }
  if (failedStart && !job.releasedAt) return ['review the failed coding start in the web app', '', 'blocked'];
  if (dollarsExhausted) return ['review the pilot allowance; no automatic top-up', '', 'blocked'];
  if (attemptsExhausted) return ['review the pilot allowance', '', 'blocked'];
  if (awaiting) return [awaiting.proposal.kind === 'coding' ? 'review the coding assignment: ' : 'decide on the proposal: ', awaiting.proposal.title, 'awaiting_decision'];
  if (needsContext) return ['answer Eve\'s question in a new request: ', needsContext.proposal?.question ?? needsContext.proposal?.title ?? '', 'awaiting_decision'];
  if (notSent) return ['check the allowance and brief size, then ask again', '', 'blocked'];
  if (f.acknowledged) return ['start a fresh request; the failed review stays in history', '', 'ready'];
  if (v.continuationAvailable) return ['review the next Eve request', '', 'awaiting_decision'];
  if (open) return ['work on: ', open.title, 'completed', 'Decision recorded'];
  const finished = done || (job && job.releasedAt && result === 'merged_pr') ? 'completed' : 'ready';
  if (priority) return ['priority: ', priority.text, finished];
  return ['ask Eve for the next useful step', '', finished];
}

/** True when a recorded thinking request is older than the hosted limit allows (display only). */
export function requestStalled(record, observedAt) {
  const nowMs = Date.parse(observedAt ?? '');
  return Boolean(record?.status === 'thinking' && !record.local && Number.isFinite(nowMs) && nowMs - Date.parse(record.createdAt) > STALLED_AFTER_MS);
}

/** One of OWNER_STATES' keys plus its label, derived from the same branch as the Next text. */
export function ownerState(view, { now } = {}) {
  const [, , key, label] = next(facts(view, { now }));
  return { key, label: label ?? OWNER_STATES[key] };
}

/**
 * @param {object} view steward view / web state
 * @param {{ link?: string, state?: boolean, now?: string }} [options] optional link appended after the text;
 *   state prefixes the owner state; now overrides the view's server time (view.observedAt)
 * @returns {string} at most 280 characters including the link
 */
export function statusSummary(view, { link = '', state = false, now } = {}) {
  const f = facts(view, { now });
  const [nextFixed, nextDetail, key, label] = next(f);
  const parts = [...(state ? [['State: ', label ?? OWNER_STATES[key], '']] : []), ['Progress: ', ...progress(f)], ['Blocker: ', ...blocker(f)], ['Next: ', nextFixed, nextDetail]];
  const suffix = typeof link === 'string' && link.trim() ? `\n${link.trim()}` : '';
  const budget = STATUS_SUMMARY_LIMIT - suffix.length;
  const render = limits => parts.map(([label, fixed, detail], i) => `${label}${fixed}${detail ? clip(detail, limits[i]).replace(/\.$/, '') : ''}.`).join(' ');
  const limits = parts.map(() => 80);
  let text = render(limits);
  for (let i = 0; text.length > budget && i < parts.length; i++) {
    const excess = text.length - budget;
    limits[i] = Math.max(MIN_DETAIL, limits[i] - excess);
    text = render(limits);
  }
  if (text.length > budget) text = clip(text, budget);
  return `${text}${suffix}`;
}
