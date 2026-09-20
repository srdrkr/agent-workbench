import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (ok, code = 'CONTINUATION_UNAVAILABLE') => { if (!ok) throw new Error(code); };
export const attemptLimit = state => state.maxProviderAttempts ?? 5;
const attempts = state => Object.values(state.requests).filter(r => r.provider).length;
const fingerprint = state => hash({ project: state.project, model: state.model, budget: state.budgetMicros,
  reserved: state.reservedMicros, limit: attemptLimit(state), paused: state.paused,
  requests: state.requests, commitments: state.commitments, coding: state.coding, telegram: state.telegram });

// This is a single post-pilot decision, not a budget reset or recurring allowance.
export function continuationPacket(state, now) {
  need(!state.paused && !state.coding?.paused && !state.coding?.active && !state.continuation
    && attemptLimit(state) === 5 && attempts(state) === 5 && state.reservedMicros < state.budgetMicros
    && state.project.sources.length < 12 && !state.project.sources.some(s => s.id === 'coding-result')
    && state.project.sources.every(s => s.exposure === 'model_allowed' && Date.parse(s.observedAt) <= Date.parse(now) && Date.parse(s.expiresAt) > Date.parse(now))
    && !Object.values(state.telegram?.updates ?? {}).some(u => u.status === 'accepted'));
  const jobs = Object.values(state.coding?.jobs ?? {});
  need(!jobs.some(j => !j.releasedAt));
  const closed = jobs.filter(j => j.contextRevision === state.project.revision && j.spec.visibility === 'public'
    && j.execution === 'exited' && j.executionObservation?.markerVerified && j.releasedAt
    && j.result?.source === 'github_api' && j.result.result === 'tested_draft_pr' && j.result.stable
    && j.result.approvedBase && j.result.scopeMatches
    && j.result.collectionStartedEvent > j.executionObservation.recordedEvent
    && Date.parse(j.result.observedAt) <= Date.parse(now) && Date.parse(j.result.observedAt) > Date.parse(now) - 86400000
    && /^[a-f0-9]{40}$/.test(j.result.headSha) && Number.isSafeInteger(j.result.prNumber) && j.result.prNumber > 0
    && j.result.prUrl === `https://github.com/${j.spec.repository}/pull/${j.result.prNumber}`
    && j.spec.requiredChecks.every(c => j.result.requiredChecks.some(r => r.name === c.name && r.appId === c.appId && r.status === 'completed' && r.conclusion === 'success')));
  need(closed.length === 1);
  const job = closed[0];
  const resolvedRequestIds = [];
  for (const record of Object.values(state.requests)) {
    need(record.status !== 'thinking');
    if (record.status !== 'held') continue;
    const p = record.provider, retry = state.requests[record.retryRequestId];
    need(record.completedAt && p?.intentAt && p.sessionId && p.reservedMicros > 0
      && [429, 503].includes(p.httpStatus) && p.rejection?.httpStatus === p.httpStatus
      && ['rate_limit_exceeded', 'rate_limit_error', 'overloaded_error', 'api_error'].includes(p.rejection.errorCategory)
      && p.rejection.providerErrorCode !== 'enforced_spend_limit_reached'
      && record.contextRevision === state.project.revision && record.judge === state.model
      && retry?.retryOf === record.id && retry.inputHash === record.inputHash && retry.judge === record.judge
      && retry.contextRevision === record.contextRevision && retry.projectId === record.projectId
      && retry.completedAt && retry.proposalHash && retry.provider?.httpStatus >= 200 && retry.provider.httpStatus < 300
      && retry.status === 'coding_dispatched' && job.id === retry.id);
    resolvedRequestIds.push(record.id);
  }
  const content = JSON.stringify({ taskId: job.spec.taskId, repository: job.spec.repository,
    providerObservation: { state: 'exited', observedAt: job.executionObservation.observedAt, source: 'owner_provider_ui' },
    githubObservation: { result: 'tested_draft_pr', prUrl: job.result.prUrl, headSha: job.result.headSha,
      observedAt: job.result.observedAt, source: 'github_api', scopeMatches: true,
      requiredChecks: job.result.requiredChecks.map(c => ({ name: c.name, conclusion: c.conclusion })) },
    closedAt: job.releasedAt, interpretation: 'The coding run is closed. This is a time-stamped draft PR and checks snapshot, not proof of merge or deployment. The original dispatch receipt was unrecognized; provider completion was observed separately.' });
  need(content.length <= 4000);
  return { fingerprint: fingerprint(state), contextRevision: state.project.revision, model: state.model,
    previousLimit: 5, nextLimit: 6, budgetMicros: state.budgetMicros, reservedMicros: state.reservedMicros,
    resolvedRequestIds, source: { id: 'coding-result', title: 'Verified coding result at owner review',
      revision: hash(content), observedAt: now, expiresAt: new Date(Math.min(Date.parse(now) + 86400000,
        ...state.project.sources.map(s => Date.parse(s.expiresAt)))).toISOString(), content, exposure: 'model_allowed' } };
}
export async function reviewContinuation(store, now) {
  return store.change(state => {
    const packet = { ...continuationPacket(state, now), expiresAt: new Date(Date.parse(now) + 15 * 60000).toISOString() };
    packet.reviewHash = hash(packet); state.continuationReview = packet;
    return packet;
  });
}
export async function approveContinuation(store, { reviewHash }, now) {
  return store.change(state => {
    if (state.continuation?.reviewHash === reviewHash && typeof reviewHash === 'string') return state.continuation;
    const preview = state.continuationReview;
    need(typeof reviewHash === 'string' && preview?.reviewHash === reviewHash && Date.parse(preview.expiresAt) > Date.parse(now), 'CONTINUATION_REVIEW_STALE');
    const current = continuationPacket(state, now);
    need(preview.fingerprint === current.fingerprint, 'CONTINUATION_REVIEW_STALE');
    for (const id of preview.resolvedRequestIds) {
      state.requests[id].status = 'resolved_rejection';
      state.requests[id].resolution = { kind: 'successful_linked_recovery', at: now, reviewHash };
    }
    state.maxProviderAttempts = 6;
    state.continuation = { reviewHash, approvedAt: now, model: state.model, source: preview.source, contextRevision: preview.contextRevision };
    state.events.push({ seq: state.events.length + 1, kind: 'continuation_approved', at: now,
      data: { reviewHash, previousLimit: 5, nextLimit: 6, budgetMicros: state.budgetMicros,
        retainedReservations: state.reservedMicros, resolvedRequestIds: preview.resolvedRequestIds } });
    return state.continuation;
  });
}
export function judgmentProject(state, now) {
  const project = structuredClone(state.project);
  const attempted = new Set(Object.values(state.coding?.jobs ?? {}).map(j => j.spec.taskId));
  project.codingCandidates = project.codingCandidates.filter(c => !attempted.has(c.spec.taskId));
  if (state.continuation) {
    need(state.continuation.contextRevision === project.revision && state.continuation.model === state.model, 'CONTINUATION_CONTEXT_CHANGED');
    const source = state.continuation.source;
    need(Date.parse(source.expiresAt) > Date.parse(now), 'CONTINUATION_SOURCE_EXPIRED');
    project.sources.push(structuredClone(source));
  }
  return project;
}
