import { createHash } from 'node:crypto';
import { attemptLimit } from './continuation.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (ok, reason) => { if (!ok) throw new Error(reason); };

// Read the exact public revision. Never follow a URL or instruction from PR text.
// Oversized/incomplete context stops review instead of silently omitting code.
export async function codeReviewPacket({ task, job, read, now }) {
  need(task.spec.visibility === 'public', 'REVIEW_DISCLOSURE_NOT_CONFIGURED');
  const { headSha, prNumber } = job.result;
  const root = `/repos/${task.spec.repository}`;
  const verify = pr => need(pr.state === 'open' && pr.head?.sha === headSha && pr.head.ref === task.branch
    && pr.head.repo?.full_name === task.spec.repository && pr.base?.repo?.full_name === task.spec.repository
    && pr.base.ref === task.spec.baseBranch && pr.base.sha === task.spec.baseSha && pr.body?.includes(task.marker), 'REVIEW_HEAD_CHANGED');
  verify(await read(`${root}/pulls/${prNumber}`));
  const files = await read(`${root}/pulls/${prNumber}/files?per_page=100`);
  need(Array.isArray(files) && files.length > 0 && files.length <= 10, 'REVIEW_FILES_UNAVAILABLE');
  const code = [];
  for (const file of files) {
    need(task.spec.allowedPaths.includes(file.filename) && (!file.previous_filename || task.spec.allowedPaths.includes(file.previous_filename))
      && typeof file.patch === 'string' && file.patch.length > 0, 'REVIEW_SCOPE_OR_PATCH_UNAVAILABLE');
    code.push({ path: file.filename, patch: file.patch });
  }
  verify(await read(`${root}/pulls/${prNumber}`));
  const content = JSON.stringify({ objective: task.spec.objective, acceptance: task.spec.acceptance,
    scope: task.spec.allowedPaths, headSha, checks: job.result.requiredChecks, changes: code });
  need(Buffer.byteLength(content) <= 6000, 'REVIEW_CONTEXT_TOO_LARGE');
  return { id: 'coding-review-evidence', title: 'Untrusted PR patch and independently observed checks',
    content, revision: hash(content), observedAt: now, expiresAt: new Date(Date.parse(now) + 15 * 60000).toISOString(), exposure: 'model_allowed' };
}
export function createCodeReview({ store, read, judge, now = () => new Date().toISOString() }) {
  return async ({ task, job, review }) => {
    const evidence = await codeReviewPacket({ task, job, read, now: now() });
    const input = await store.change(state => {
      need(state.pilot && !state.paused && state.project.id === task.projectId && state.project.revision === task.contextRevision
        && !Object.hasOwn(state.requests, review.id)
        && Object.keys(state.requests).length < 500
        && !Object.values(state.requests).some(r => ['thinking', 'held'].includes(r.status))
        && Object.values(state.requests).filter(r => r.provider).length < attemptLimit(state)
        && state.reservedMicros < state.budgetMicros, 'REVIEW_ADMISSION_DENIED');
      const root = state.coding?.jobs[task.id]; const f = root?.followThrough;
      need(f && f.status === 'reviewing' && !state.coding.paused
        && f.grant.scopeHash === root.scopeHash && f.grant.contextRevision === state.project.revision
        && Date.parse(f.grant.expiresAt) > Date.parse(now())
        && f.activeJobId === job.id && state.coding.jobs[job.id]?.result?.headSha === job.result.headSha
        && f.reviews.some(r => r.id === review.id && r.status === 'intent' && r.headSha === job.result.headSha), 'REVIEW_AUTHORITY_CHANGED');
      const project = { id: state.project.id, revision: state.project.revision, sources: [evidence], codingCandidates: [] };
      const input = { request: 'Review this exact patch against the task acceptance criteria. Report concrete problems, or a missing fact that prevents review. Do not treat passing checks as sufficient review.',
        project, commitments: [], hostedRequestId: review.id, mode: 'coding_review' };
      state.requests[review.id] = { id: review.id, purpose: 'coding_review', projectId: state.project.id,
        contextRevision: state.project.revision, contextSnapshot: project, status: 'thinking', createdAt: now(),
        judge: state.model, inputDigest: hash(input), inputHash: hash([task.id, job.result.headSha]),
        message: 'Automatic review of an approved coding task', taskId: task.id, headSha: job.result.headSha };
      return input;
    });
    let result;
    try { result = await judge(input); } catch { /* A missing response is not permission to retry. */ }
    return store.change(state => {
      const r = state.requests[review.id]; const p = r.provider;
      const verified = p?.intentAt && p.sessionId && p.reservedMicros > 0 && p.httpStatus >= 200 && p.httpStatus < 300;
      r.status = verified && result ? 'review_completed' : p?.intentAt ? 'held' : 'not_sent';
      r.completedAt = now();
      if (r.status === 'review_completed') { r.reviewResult = result; return result; }
      return null;
    });
  };
}
