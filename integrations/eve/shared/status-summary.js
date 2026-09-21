/**
 * One short project-status summary shared by Telegram and the web view.
 *
 * It reads the steward view (`steward.view()` / `GET /api/steward/state`) and
 * returns plain text of at most 280 characters, including an optional link.
 * Only recorded evidence is used: GitHub observations, owner-reported
 * commitments, saved notes, request status and pilot limits. Nothing here
 * reads or writes storage, and nothing is presented as more certain than the
 * record supports (a draft PR is not a merge, a merge is not a deployment and
 * a GitHub result never proves the Claude session ended).
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

const GITHUB = {
  merged_pr: 'PR merged; deployment not verified',
  tested_draft_pr: 'draft PR passed required checks',
  needs_review: 'PR open; checks or review pending',
  branch_without_pr: 'branch pushed; no PR yet',
  conflicting_prs: 'several PRs match one task; needs review',
  not_found: 'no GitHub result recorded yet',
};
const CONTINUATION = {
  CONTINUATION_CONTEXT_CHANGED: 'brief changed after the follow-up was approved',
  CONTINUATION_SOURCE_EXPIRED: 'reviewed coding result expired',
  CONTINUATION_UNAVAILABLE: 'coding run must close before continuing',
};

function facts(view) {
  const v = view && typeof view === 'object' ? view : {};
  const revision = v.project?.revision;
  const current = list(v.requests).filter(r => !r.contextRevision || revision === undefined || r.contextRevision === revision);
  const jobs = list(v.progress?.jobs).length ? list(v.progress.jobs) : list(v.codingJobs);
  const job = latest(jobs, 'dispatchStartedAt');
  const commitments = list(v.progress?.commitments).length ? list(v.progress.commitments) : list(v.commitments);
  return {
    v, job,
    held: current.find(r => r.status === 'held') ?? null,
    thinking: current.find(r => r.status === 'thinking') ?? null,
    awaiting: current.find(r => r.status === 'awaiting_approval' && r.proposal) ?? null,
    done: latest(commitments.filter(c => c.completedAt), 'completedAt'),
    open: latest(commitments.filter(c => !c.completedAt), 'approvedAt'),
    note: list(v.progress?.notes).find(n => n.kind !== 'priority') ?? null,
    priority: v.progress?.priority ?? null,
    exhausted: Number.isFinite(v.providerAttempts) && Number.isFinite(v.maxProviderAttempts) && v.providerAttempts >= v.maxProviderAttempts,
    jobOpen: Boolean(job && !job.releasedAt),
    jobStarted: Boolean(job && ['accepted', 'unknown'].includes(job.dispatch)),
  };
}

// Each part is [fixed text, detail]; the detail is the only piece that shrinks.
function progress({ job, jobOpen, jobStarted, done, open, note }) {
  if (job) {
    const result = job.result?.result;
    if (result) return [(GITHUB[result] ?? 'GitHub result needs review') + (jobOpen ? '; Claude finish unconfirmed' : ''), ''];
    if (!jobStarted) return ['Claude start unconfirmed for: ', job.spec?.objective];
    return [jobOpen ? 'Claude working, no GitHub result yet: ' : 'coding run closed without a GitHub result: ', job.spec?.objective];
  }
  if (done) return ['owner reported done: ', done.title];
  if (open) return ['committed, not yet done: ', open.title];
  if (note) return ['latest note: ', note.text];
  return ['no recorded progress yet', ''];
}

function blocker({ v, held, thinking, exhausted, job, jobStarted }) {
  if (v.continuationProblem) return [CONTINUATION[v.continuationProblem] ?? 'continuation needs operator review', ''];
  if (v.paused) return ['new model requests paused', ''];
  if (v.contextFresh === false) return ['project brief expired', ''];
  if (exhausted) return ['model allowance used up', ''];
  if (held) return ['a held model attempt needs review', ''];
  if (job && !job.releasedAt && !jobStarted) return ['coding start unconfirmed; check Claude first', ''];
  if (job?.stopRequested && !job.releasedAt) return ['coding paused; stop requested, not confirmed', ''];
  if (v.monitor?.lastError) return ['GitHub check unavailable; older result shown', ''];
  if (thinking) return ['waiting for Eve', ''];
  if (job?.result?.result === 'conflicting_prs') return ['several PRs match one task', ''];
  return ['none recorded', ''];
}

function next({ v, held, thinking, exhausted, job, jobOpen, jobStarted, awaiting, open, priority }) {
  if (v.continuationProblem) return ['review continuation in the web app', ''];
  if (v.paused) return ['resume requests when ready', ''];
  if (v.contextFresh === false) return ['update the project brief', ''];
  if (exhausted) return ['review the pilot allowance', ''];
  if (held) return ['review the held attempt', ''];
  if (thinking) return ['wait for Eve, then review the proposal', ''];
  if (job && jobOpen) {
    if (!jobStarted) return ['check Claude, then confirm or close the run', ''];
    const result = job.result?.result;
    if (result === 'tested_draft_pr') return ['confirm Claude finished, then review the draft PR', ''];
    if (result === 'merged_pr') return ['confirm Claude finished and close the run', ''];
    if (result === 'needs_review' || result === 'conflicting_prs') return ['review the PR state, then confirm Claude finished', ''];
    return ['wait for GitHub progress; confirm when Claude finishes', ''];
  }
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
  const render = limits => parts.map(([label, fixed, detail], i) => `${label}${fixed}${detail ? clip(detail, limits[i]) : ''}.`).join(' ');
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
