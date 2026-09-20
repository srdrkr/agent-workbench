import { createHash } from 'node:crypto';
import { validateProject } from '../../../src/steward-policy.js';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const requireValue = (value, code) => { if (!value) throw new Error(code); };
const activeWork = state => Object.values(state.requests).some(r => ['thinking', 'held'].includes(r.status)) || state.coding?.active
  || Object.values(state.coding?.jobs ?? {}).some(j => ['accepted', 'unknown'].includes(j.dispatch) && !j.releasedAt)
  || Object.values(state.telegram?.updates ?? {}).some(u => u.status === 'accepted');
function proposal(input, now) {
  requireValue(input && typeof input === 'object', 'INVALID_CONTEXT');
  validateProject(input);
  requireValue(input.sources.every(s => s.exposure === 'model_allowed' && Date.parse(s.observedAt) <= Date.parse(now) && Date.parse(s.expiresAt) > Date.parse(now)), 'INVALID_CONTEXT');
  requireValue(Buffer.byteLength(JSON.stringify(input)) <= 16000, 'INVALID_CONTEXT');
  return structuredClone(input);
}
export async function previewContext(store, input, now) {
  const project = proposal(input, now);
  requireValue(!project.sources.some(s => s.id === 'project-progress') && project.sources.length < 12, 'INVALID_CONTEXT');
  return store.change(state => {
    requireValue(!activeWork(state), 'CONTEXT_WORK_UNRESOLVED');
    const version = (state.contextVersion ?? 0) + 1;
    // The adoption number prevents A -> B -> A from reviving old approvals.
    const revision = hash({ project, version });
    const preview = { expectedRevision: state.project.revision, project: { ...project, revision }, version,
      expiresAt: new Date(Date.parse(now) + 15 * 60_000).toISOString() };
    preview.id = hash(preview);
    state.contextPreview = preview;
    return { ...preview, previousProject: state.project, providerAttempts: Object.values(state.requests).filter(r => r.provider).length,
      reservedMicros: state.reservedMicros, budgetMicros: state.budgetMicros,
      historicalCommitments: Object.keys(state.commitments).length };
  });
}
export async function applyContext(store, { previewId, expectedRevision }, now) {
  requireValue(typeof previewId === 'string' && /^[a-f0-9]{64}$/.test(previewId), 'INVALID_CONTEXT');
  return store.change(state => {
    const prior = state.contextChanges?.find(c => c.previewId === previewId);
    if (prior) { requireValue(prior.previousRevision === expectedRevision, 'CONTEXT_PREVIEW_STALE'); return prior; }
    const preview = state.contextPreview;
    requireValue(preview?.id === previewId && preview.expectedRevision === expectedRevision && state.project.revision === expectedRevision
      && Date.parse(preview.expiresAt) > Date.parse(now), 'CONTEXT_PREVIEW_STALE');
    requireValue(!activeWork(state), 'CONTEXT_WORK_UNRESOLVED');
    const { revision, ...project } = preview.project; proposal(project, now);
    state.contextChanges ??= [];
    requireValue(state.contextChanges.length < 100, 'CONTEXT_CHANGE_LIMIT');
    const change = { previewId, previousRevision: expectedRevision, projectRevision: revision, at: now,
      previousProject: state.project, project: preview.project };
    state.contextChanges.push(change); state.project = preview.project; state.contextVersion = preview.version;
    delete state.contextPreview;
    state.events.push({ seq: state.events.length + 1, kind: 'context_approved', at: now, data: { previewId, previousRevision: expectedRevision, projectRevision: revision } });
    return change;
  });
}
