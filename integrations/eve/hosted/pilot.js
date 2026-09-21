import { followThroughView } from './follow-through.js';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error(code); };
const boundedText = (text, limit) => { let value = text.slice(0, limit); while (JSON.stringify(value).length > limit) value = value.slice(0, -20); return value; };
const event = (s, kind, data, at) => s.events.push({ seq: s.events.length + 1, kind, data, at });
const fingerprint = s => hash({ model: s.model, budget: s.budgetMicros, limit: s.maxProviderAttempts ?? 5, pilot: s.pilot?.approvedAt });
export function projectIdForRevision(state, revision) {
  if (revision === state.project.revision) return state.project.id;
  for (const change of state.contextChanges ?? []) {
    if (change.previousProject?.revision === revision) return change.previousProject.id;
    if (change.project?.revision === revision) return change.project.id;
  }
  return null;
}
export function progressView(state) {
  const belongs = item => (item.projectId ?? projectIdForRevision(state, item.contextRevision)) === state.project.id;
  return {
    notes: (state.memory?.notes ?? []).filter(belongs).slice(-20).reverse(),
    priority: (state.memory?.notes ?? []).filter(n => belongs(n) && n.kind === 'priority').at(-1) ?? null,
    commitments: Object.values(state.commitments).filter(belongs).sort((a, b) => (b.approvedAt ?? '').localeCompare(a.approvedAt ?? '')),
    jobs: Object.values(state.coding?.jobs ?? {}).filter(belongs).sort((a, b) => (b.dispatchStartedAt ?? '').localeCompare(a.dispatchStartedAt ?? '')),
  };
}
// A compact projection of durable typed facts, never an assistant-written replacement brief.
export function progressSource(state, now) {
  const progress = progressView(state);
  const follow = followThroughView(state);
  const facts = {
    followThrough: follow ? { status: follow.status, reason: follow.reason, reviews: follow.reviews, corrections: follow.corrections, nextCheckAt: follow.nextCheckAt } : null,
    availableRecords: { notes: progress.notes.length, commitments: progress.commitments.length, codingJobs: progress.jobs.length },
    meaning: 'A bounded recent summary; older records remain stored. Historical observations, not live guarantees. Owner reports are labeled. Merge does not prove deployment. Never repeat completed work solely because an old brief lists it.',
    priority: progress.priority ? { text: boundedText(progress.priority.text, 700), at: progress.priority.at, source: 'owner_priority' } : null,
    notes: progress.notes.filter(n => n.kind !== 'priority').slice(0, 3).map(n => ({ text: boundedText(n.text, 250), at: n.at, source: 'owner_note' })),
    commitments: [...progress.commitments].sort((a, b) => Number(Boolean(a.completedAt)) - Number(Boolean(b.completedAt))).slice(0, 4).map(c => ({ title: boundedText(c.title, 120), status: c.completedAt ? 'owner_reported_complete' : 'approved', at: c.completedAt ?? c.approvedAt })),
    coding: progress.jobs.slice(0, 2).map(j => ({ task: boundedText(j.spec.objective, 180), dispatch: j.dispatch, providerState: j.execution,
      providerObservedAt: j.executionObservation?.observedAt ?? null, closedAt: j.releasedAt ?? null,
      github: j.result ? { result: j.result.result, prUrl: j.result.prUrl ?? null, headSha: j.result.headSha ?? null,
        observedAt: j.result.observedAt, mergedAt: j.result.mergedAt ?? null } : null })),
  };
  // Bound the serialized projection (including JSON escaping), retaining full records in storage.
  while (JSON.stringify(facts).length > 3800 && facts.notes.length) facts.notes.pop();
  while (JSON.stringify(facts).length > 3800 && facts.commitments.length) facts.commitments.pop();
  while (JSON.stringify(facts).length > 3800 && facts.coding.length) facts.coding.pop();
  while (JSON.stringify(facts).length > 3800 && facts.priority?.text.length) facts.priority.text = facts.priority.text.slice(0, -100);
  const content = JSON.stringify(facts);
  return { id: 'project-progress', title: 'Durable project progress (dated facts)', revision: hash(facts), content,
    observedAt: now, expiresAt: new Date(Date.parse(now) + 86400000).toISOString(), exposure: 'model_allowed' };
}
export async function reviewPilot(store, { budgetMicros, maxProviderAttempts }, now) {
  need(Number.isSafeInteger(budgetMicros) && budgetMicros >= 0 && budgetMicros <= 10_000_000
    && Number.isSafeInteger(maxProviderAttempts) && maxProviderAttempts >= 1 && maxProviderAttempts <= 250, 'PILOT_SETTINGS_INVALID');
  return store.change(state => {
    need(budgetMicros >= state.reservedMicros && maxProviderAttempts >= Object.values(state.requests).filter(r => r.provider).length, 'PILOT_SETTINGS_INVALID');
    const review = { budgetMicros, maxProviderAttempts, previousBudgetMicros: state.budgetMicros,
      reservedMicros: state.reservedMicros, model: state.model, fingerprint: fingerprint(state),
      expiresAt: new Date(Date.parse(now) + 15 * 60000).toISOString() };
    review.reviewHash = hash(review); state.pilotReview = review; return review;
  });
}
export async function approvePilot(store, { reviewHash }, now) {
  return store.change(state => {
    if (typeof reviewHash === 'string' && state.pilot?.reviewHash === reviewHash) return state.pilot;
    const review = state.pilotReview;
    need(typeof reviewHash === 'string' && review?.reviewHash === reviewHash && review.fingerprint === fingerprint(state)
      && Date.parse(review.expiresAt) > Date.parse(now) && review.budgetMicros >= state.reservedMicros
      && review.maxProviderAttempts >= Object.values(state.requests).filter(r => r.provider).length, 'PILOT_REVIEW_STALE');
    need(!Object.values(state.requests).some(r => ['thinking', 'held'].includes(r.status)) && !state.coding?.active, 'CONTEXT_WORK_UNRESOLVED');
    need(!state.project.sources.some(s => s.id === 'project-progress') && state.project.sources.length < 12, 'INVALID_CONTEXT');
    state.budgetMicros = review.budgetMicros; state.maxProviderAttempts = review.maxProviderAttempts;
    state.pilot = { reviewHash, approvedAt: now, model: state.model };
    // The old single-use continuation remains auditable, but no longer governs future briefs.
    event(state, 'pilot_allowance_approved', { ...state.pilot, budgetMicros: state.budgetMicros,
      maxProviderAttempts: state.maxProviderAttempts, retainedReservations: state.reservedMicros }, now);
    return state.pilot;
  });
}
export async function saveNote(store, { text, kind = 'note', expectedContextRevision }, now) {
  need(['note', 'priority'].includes(kind) && typeof text === 'string' && text.trim() && text.length <= 1000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), 'INVALID_REQUEST');
  return store.change(state => {
    need(state.pilot && state.project.revision === expectedContextRevision, 'APPROVAL_MISMATCH');
    state.memory ??= { notes: [] }; need(state.memory.notes.length < 500, 'MEMORY_LIMIT');
    const note = { id: `note-${state.events.length + 1}`, text: text.trim(), kind, projectId: state.project.id,
      contextRevision: state.project.revision, at: now, source: 'authenticated_owner' };
    state.memory.notes.push(note); event(state, 'project_note_saved', { noteId: note.id }, now); return note;
  });
}
export async function completeCommitment(store, { commitmentId, expectedContextRevision }, now) {
  return store.change(state => {
    const c = typeof commitmentId === 'string' && Object.hasOwn(state.commitments, commitmentId) && state.commitments[commitmentId];
    need(c && state.project.revision === expectedContextRevision
      && (c.projectId ?? projectIdForRevision(state, c.contextRevision)) === state.project.id, 'APPROVAL_MISMATCH');
    if (!c.completedAt) { c.completedAt = now; c.completionSource = 'owner_report'; event(state, 'commitment_completed', { commitmentId }, now); }
    return c;
  });
}
