import { followThroughNotice } from '../shared/follow-through-notice.js';
import { createHash } from 'node:crypto';

export const FOLLOW_THROUGH_LIMITS = Object.freeze({ corrections: 2, reviews: 3, lifetimeMs: 86400000, checkMs: 15 * 60000 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error(code); };
const terminal = new Set(['blocked', 'finished']);
const own = (object, key) => Object.hasOwn(object ?? {}, key) ? object[key] : undefined;
const ended = job => ['exited', 'stopped'].includes(job?.execution)
  && job.executionObservation?.markerVerified === true
  && job.result?.collectionStartedEvent > job.executionObservation.recordedEvent;
const record = (state, task, kind, data, at) => state.events.push({ seq: state.events.length + 1, kind: `follow_through_${kind}`, data: { taskId: task.id, ...data }, at });
const stop = (state, task, reason, at) => {
  task.followThrough.status = 'blocked'; task.followThrough.reason = reason; task.followThrough.nextCheckAt = null;
  record(state, task, 'blocked', { reason }, at);
};
export function followThroughGrant(task, at) {
  return { version: 1, scopeHash: task.scopeHash, contextRevision: task.contextRevision,
    maxCorrections: FOLLOW_THROUGH_LIMITS.corrections, maxReviews: FOLLOW_THROUGH_LIMITS.reviews,
    expiresAt: new Date(Date.parse(at) + FOLLOW_THROUGH_LIMITS.lifetimeMs).toISOString() };
}
export function followThroughView(state) {
  const task = Object.values(state.coding?.jobs ?? {}).filter(j => j.projectId === state.project.id && j.followThrough)
    .sort((a, b) => b.dispatchStartedAt.localeCompare(a.dispatchStartedAt))[0];
  if (!task) return null;
  const f = task.followThrough;
  return { taskId: task.id, status: f.status, reason: f.reason, reviews: f.reviews.length,
    corrections: f.attempts.length, maxCorrections: f.grant.maxCorrections, nextCheckAt: f.nextCheckAt,
    history: state.events.filter(e => e.data?.taskId === task.id && e.kind.startsWith('follow_through_')).slice(-30),
    lastReview: f.reviews.at(-1) ?? null };
}

// This controller owns admission, not model/provider capabilities. Adapters must
// preserve the exact head, scope and intent ID. No adapter is inferred from a URL.
export class FollowThrough {
  constructor({ store, coding, review, correct = null, now = () => new Date().toISOString() }) {
    this.store = store; this.coding = coding; this.review = review; this.correct = correct; this.now = now;
  }
  async run() {
    const ticket = await this.store.change(state => {
      if (!state.pilot || state.paused || state.coding?.paused) return null;
      const task = Object.values(state.coding?.jobs ?? {}).filter(j => j.followThrough
        && j.projectId === state.project.id && !terminal.has(j.followThrough.status)
        && (!j.followThrough.nextCheckAt || j.followThrough.nextCheckAt <= this.now()))
        .sort((a, b) => (a.followThrough.nextCheckAt ?? '').localeCompare(b.followThrough.nextCheckAt ?? ''))[0];
      if (!task) return null;
      const f = task.followThrough;
      if (f.status === 'reviewing' || f.status === 'dispatching') {
        stop(state, task, 'Previous action outcome is uncertain; automatic replay stopped.', this.now()); return null;
      }
      if (f.grant.scopeHash !== task.scopeHash || f.grant.contextRevision !== state.project.revision
        || Date.parse(f.grant.expiresAt) <= Date.parse(this.now())
        || !state.project.sources.every(s => Date.parse(s.observedAt) <= Date.parse(this.now()) && Date.parse(s.expiresAt) > Date.parse(this.now()))) {
        stop(state, task, 'Task authority or project context expired or changed.', this.now()); return null;
      }
      if (state.reservedMicros >= state.budgetMicros) {
        stop(state, task, 'Model allowance exhausted; no refill or retry.', this.now()); return null;
      }
      f.nextCheckAt = new Date(Date.parse(this.now()) + FOLLOW_THROUGH_LIMITS.checkMs).toISOString();
      record(state, task, 'wake', { activeJobId: f.activeJobId }, this.now());
      return { rootId: task.id, activeId: f.activeJobId };
    });
    if (!ticket) return { skipped: true };
    let job;
    try { job = await this.coding.reconcile({ requestId: ticket.activeId }); }
    catch { return { waiting: 'evidence_unavailable' }; }
    const admission = await this.store.change(state => {
      const task = own(state.coding?.jobs, ticket.rootId); const f = task?.followThrough;
      if (!f || terminal.has(f.status) || state.paused || state.coding?.paused || f.activeJobId !== ticket.activeId
        || task.projectId !== state.project.id || f.grant.contextRevision !== state.project.revision
        || Date.parse(f.grant.expiresAt) <= Date.parse(this.now())) return null;
      const current = own(state.coding.jobs, ticket.activeId);
      // Work only from the current persisted observation, not an older concurrent response.
      if (current.result?.headSha !== job.result?.headSha) return null;
      if (job.result?.result === 'merged_pr') { f.status = 'finished'; f.reason = 'PR merged; no further coding.'; f.nextCheckAt = null; record(state, task, 'finished', {}, this.now()); return null; }
      if (!job.result?.prNumber || !job.result.headSha) { f.status = 'waiting_for_pr'; return null; }
      if (!job.result.scopeMatches || !job.result.approvedBase) { stop(state, task, 'PR scope or approved base changed.', this.now()); return null; }
      const lastAttempt = f.attempts.at(-1);
      if (lastAttempt && ended(current) && lastAttempt.headSha === current.result.headSha) {
        stop(state, task, 'Correction ended without a new commit.', this.now()); return null;
      }
      const prior = f.reviews.find(r => r.headSha === job.result.headSha);
      if (prior) return prior.status === 'completed' && prior.result.verdict === 'correct' ? { correction: true, review: prior } : null;
      if (f.reviews.length >= f.grant.maxReviews) { stop(state, task, 'Three reviews consumed; owner decision required.', this.now()); return null; }
      if (Object.values(state.requests).some(r => ['held', 'thinking'].includes(r.status))) {
        f.status = 'waiting_for_model'; return null;
      }
      const review = { id: `review-${hash([task.id, job.result.headSha]).slice(0, 32)}`, headSha: job.result.headSha,
        status: 'intent', at: this.now(), evidenceHash: hash(job.result) };
      f.reviews.push(review); f.status = 'reviewing';
      record(state, task, 'review_intent', { reviewId: review.id, headSha: review.headSha, evidenceHash: review.evidenceHash }, this.now());
      return { review, task: structuredClone(task), job: structuredClone(current) };
    });
    if (!admission) return { waiting: true };
    if (admission.correction) return this.dispatch(ticket.rootId, admission.review);
    let result; let failureReason = 'Review failed or was invalid; automatic replay stopped.';
    try { result = await this.review(admission); } catch (error) {
      const reasons = {
        REVIEW_CONTEXT_TOO_LARGE: 'Patch exceeds the review limit. Split the task or review this PR manually.',
        REVIEW_DISCLOSURE_NOT_CONFIGURED: 'Private code review needs an approved disclosure configuration.',
        REVIEW_SCOPE_OR_PATCH_UNAVAILABLE: 'Complete in-scope patch evidence is missing. Review the PR manually.',
        REVIEW_HEAD_CHANGED: 'The PR changed during evidence collection. Review the new head before continuing.',
      };
      failureReason = reasons[error.message] ?? failureReason;
    }
    const correction = await this.store.change(state => {
      const task = state.coding.jobs[ticket.rootId]; const f = task.followThrough;
      const r = f.reviews.find(r => r.id === admission.review.id);
      if (terminal.has(f.status)) return false;
      if (!result || !['ready', 'correct', 'blocked'].includes(result.verdict) || !Array.isArray(result.findings)
        || result.findings.length > 5 || !result.findings.every(x => task.spec.allowedPaths.includes(x.path)
          && Number.isSafeInteger(x.line) && x.line > 0 && typeof x.problem === 'string' && x.problem.length > 0 && x.problem.length <= 500)
        || (result.verdict === 'correct') !== (result.findings.length > 0)) {
        r.status = 'unknown'; stop(state, task, failureReason, this.now()); return false;
      }
      r.status = 'completed'; r.result = result; r.completedAt = this.now();
      record(state, task, 'review_result', { reviewId: r.id, verdict: result.verdict, findings: result.findings.length }, this.now());
      if (state.paused || state.project.revision !== f.grant.contextRevision) {
        stop(state, task, 'Task paused or context changed during review.', this.now()); return false;
      }
      if (state.coding.jobs[f.activeJobId]?.result?.headSha !== r.headSha) { f.status = 'waiting_for_pr'; return false; }
      if (result.verdict === 'blocked') { stop(state, task, `Review needs an owner decision: ${String(result.summary ?? '').slice(0, 500)}`, this.now()); return false; }
      if (result.verdict === 'ready') {
        // This means review-ready, not that execution ended, CI passed or deployment happened.
        f.status = 'ready_for_owner'; f.reason = 'Review found no correction. Check recorded CI and provider state before merging.';
        return false;
      }
      const keys = result.findings.map(x => hash([x.path, x.problem.toLowerCase().replace(/\s+/g, ' ').trim()]));
      const repeated = f.reviews.some(p => p !== r && p.result?.findings.some(x => keys.includes(hash([x.path, x.problem.toLowerCase().replace(/\s+/g, ' ').trim()]))));
      if (repeated) { stop(state, task, 'A finding repeated after correction; owner decision required.', this.now()); return false; }
      f.status = 'correction_ready'; return true;
    });
    return correction ? this.dispatch(ticket.rootId, admission.review) : { reviewed: true };
  }
  async dispatch(rootId, review) {
    const admission = await this.store.change(state => {
      const task = own(state.coding?.jobs, rootId); const f = task?.followThrough;
      if (!f || terminal.has(f.status) || state.paused || state.coding.paused) return null;
      const active = own(state.coding.jobs, f.activeJobId);
      if (f.attempts.length >= f.grant.maxCorrections) { stop(state, task, 'Two correction attempts consumed; owner decision required.', this.now()); return null; }
      if (!ended(active)) { f.status = 'waiting_for_provider_exit'; f.reason = 'Confirm the Claude session ended before another writer starts.'; return null; }
      if (!this.correct) { f.status = 'waiting_for_connection'; f.reason = 'Bounded correction delivery is not configured.'; return null; }
      if (state.project.revision !== f.grant.contextRevision || Date.parse(f.grant.expiresAt) <= Date.parse(this.now())
        || state.reservedMicros >= state.budgetMicros || active.result?.headSha !== review.headSha) {
        stop(state, task, 'Authority, allowance or reviewed PR head changed.', this.now()); return null;
      }
      const attempt = { id: `${rootId}-fix-${f.attempts.length + 1}`, headSha: review.headSha, status: 'intent', at: this.now() };
      f.attempts.push(attempt); f.status = 'dispatching';
      record(state, task, 'correction_intent', { attemptId: attempt.id, reviewId: review.id, headSha: review.headSha }, this.now());
      return { task: structuredClone(task), previous: structuredClone(active), review: structuredClone(f.reviews.find(r => r.id === review.id)), attempt };
    });
    if (!admission) return { waiting: true };
    let receipt;
    try { receipt = await this.correct(admission); } catch { /* An uncertain send consumes its slot. */ }
    return this.store.change(state => {
      const task = state.coding.jobs[rootId]; const f = task.followThrough; const a = f.attempts.find(a => a.id === admission.attempt.id);
      a.status = receipt?.outcome === 'accepted' ? 'accepted' : 'unknown';
      record(state, task, 'correction_result', { attemptId: a.id, outcome: a.status }, this.now());
      // A successful adapter must have persisted a new job with its real session receipt.
      const next = own(state.coding.jobs, a.id);
      if (a.status !== 'accepted' || !next || next.branch !== task.branch || next.scopeHash !== task.scopeHash || !next.session) {
        stop(state, task, 'Correction delivery uncertain or rejected; not retried.', this.now());
      } else { f.activeJobId = a.id; if (!terminal.has(f.status)) { f.status = 'waiting_for_pr'; f.reason = null; } }
      return { dispatched: a.status === 'accepted', status: f.status };
    });
  }
}

export async function notifyFollowThrough({ store, send, now = () => new Date().toISOString() }) {
  const pending = await store.change(state => {
    if (state.paused) return null;
    for (const task of Object.values(state.coding?.jobs ?? {})) {
      const f = task.followThrough;
      if (!f || task.projectId !== state.project.id || task.contextRevision !== state.project.revision) continue;
      const text = followThroughNotice(f); if (!text) continue;
      const key = hash([task.id, f.status, f.reason, f.reviews.at(-1)?.headSha]);
      f.notifications ??= {};
      if (Object.hasOwn(f.notifications, key)) continue;
      f.notifications[key] = { status: 'send_intent', at: now() };
      record(state, task, 'notification_intent', { key, status: f.status }, now());
      return { taskId: task.id, key, text };
    }
    return null;
  });
  if (!pending) return { skipped: true };
  let sent = false;
  try { sent = await send(pending.text); } catch { /* No resend on ambiguous delivery. */ }
  await store.change(state => {
    const task = state.coding.jobs[pending.taskId];
    task.followThrough.notifications[pending.key].status = sent ? 'sent' : 'delivery_unknown';
    record(state, task, 'notification_result', { key: pending.key, status: sent ? 'sent' : 'delivery_unknown' }, now());
  });
  return { sent };
}
