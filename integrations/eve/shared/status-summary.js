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
 */
export const STATUS_SUMMARY_LIMIT = 280;
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
const CONTINUATION = {
  CONTINUATION_CONTEXT_CHANGED: 'brief changed after the follow-up was approved',
  CONTINUATION_SOURCE_EXPIRED: 'reviewed coding result expired',
  CONTINUATION_UNAVAILABLE: 'coding run must close before continuing',
};

function facts(view) {
  const v = view && typeof view === 'object' ? view : {};
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
  const thinking = current.find(r => r.status === 'thinking') ?? null;
  const jobOpen = Boolean(job && !job.releasedAt && !failedStart);
  return {
    v, job, held, thinking, jobOpen, failedStart,
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

function blocker({ v, held, thinking, job, jobOpen, failedStart, startUnconfirmed, dollarsExhausted, attemptsExhausted }) {
  if (v.continuationProblem) return [CONTINUATION[v.continuationProblem] ?? 'continuation needs operator review', ''];
  if (v.paused) return ['new model requests paused', ''];
  if (v.contextFresh === false) return ['project brief expired', ''];
  if (dollarsExhausted) return [`model allowance used up (${usd(v.reservedMicros)} of ${usd(v.budgetMicros)} reserved)`, ''];
  if (attemptsExhausted) return [`request limit reached (${v.providerAttempts} of ${v.maxProviderAttempts} attempts)`, ''];
  if (held) return ['a held model attempt needs review', ''];
  if (startUnconfirmed) return ['coding start unconfirmed; check Claude first', ''];
  if (failedStart && !job.releasedAt) return [job.dispatch === 'usage_limited' ? 'Claude usage limit; coding did not start' : 'coding dispatch rejected', ''];
  if (jobOpen && job.stopRequested) return ['coding paused; stop requested, not confirmed', ''];
  if (v.monitor?.lastError) return ['GitHub check unavailable; older result shown', ''];
  if (thinking) return ['waiting for Eve', ''];
  if (job?.result?.result === 'conflicting_prs') return ['several PRs match one task', ''];
  return ['none recorded', ''];
}

function next(f) {
  const { v, held, thinking, job, jobOpen, failedStart, startUnconfirmed, running, ended, awaiting, open, priority, dollarsExhausted, attemptsExhausted } = f;
  const result = job?.result?.result;
  if (v.continuationProblem) return ['review continuation in the web app', ''];
  if (v.paused) {
    if (held) return ['review the held attempt before resuming', ''];
    if (thinking) return ['wait for Eve before resuming', ''];
    if (jobOpen) return [ended ? 'close the coding run before resuming' : 'check Claude and close the run before resuming', ''];
    return ['resume requests when ready', ''];
  }
  if (v.contextFresh === false) return ['update the project brief', ''];
  if (held) return ['review the held attempt', ''];
  if (thinking) return ['wait for Eve, then review the proposal', ''];
  if (jobOpen) {
    if (startUnconfirmed) return ['check Claude, then confirm or close the run', ''];
    if (ended) return [result === 'tested_draft_pr' ? 'close the coding run, then review the draft PR' : 'check GitHub, then close the coding run', ''];
    if (running) return ['wait for Claude; check GitHub later', ''];
    if (result === 'tested_draft_pr') return ['confirm Claude finished, then review the draft PR', ''];
    if (result === 'merged_pr') return ['confirm Claude finished and close the run', ''];
    if (result === 'needs_review' || result === 'conflicting_prs') return ['review the PR state, then confirm Claude finished', ''];
    return ['wait for GitHub progress; confirm when Claude finishes', ''];
  }
  if (job && !failedStart && UNMERGED.includes(result)) {
    return [result === 'branch_without_pr' ? 'check the pushed branch; no PR yet' : result === 'conflicting_prs' ? 'resolve the several matching PRs' : 'review the unmerged PR', ''];
  }
  if (failedStart && !job.releasedAt) return ['review the failed coding start in the web app', ''];
  if (dollarsExhausted) return ['review the pilot allowance; no automatic top-up', ''];
  if (attemptsExhausted) return ['review the pilot allowance', ''];
  if (awaiting) return [awaiting.proposal.kind === 'coding' ? 'review the coding assignment: ' : 'decide on the proposal: ', awaiting.proposal.title];
  if (v.continuationAvailable) return ['review the next Eve request', ''];
  if (open) return ['work on: ', open.title];
  if (priority) return ['priority: ', priority.text];
  return ['ask Eve for the next useful step', ''];
}

/**
 * @param {object} view steward view / web state
 * @param {{ link?: string }} [options] optional link appended after the text
 * @returns {string} at most 280 characters including the link
 */
export function statusSummary(view, { link = '' } = {}) {
  const f = facts(view);
  const parts = [['Progress: ', ...progress(f)], ['Blocker: ', ...blocker(f)], ['Next: ', ...next(f)]];
  const suffix = typeof link === 'string' && link.trim() ? `\n${link.trim()}` : '';
  const budget = STATUS_SUMMARY_LIMIT - suffix.length;
  const render = limits => parts.map(([label, fixed, detail], i) => `${label}${fixed}${detail ? clip(detail, limits[i]).replace(/\.$/, '') : ''}.`).join(' ');
  const limits = [80, 80, 80];
  let text = render(limits);
  for (let i = 0; text.length > budget && i < parts.length; i++) {
    const excess = text.length - budget;
    limits[i] = Math.max(MIN_DETAIL, limits[i] - excess);
    text = render(limits);
  }
  if (text.length > budget) text = clip(text, budget);
  return `${text}${suffix}`;
}
