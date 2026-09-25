import { followThroughView } from './follow-through.js';
import { reviewPilot, approvePilot, saveNote, completeCommitment, progressView } from './pilot.js';
import { createHash } from 'node:crypto';
import { attemptLimit, continuationPacket, reviewContinuation, approveContinuation, judgmentProject } from './continuation.js';
import { previewContext, applyContext } from './context.js';
import { validateProject, validateProposal } from '../../../src/steward-policy.js';
import { validateAssignmentDraft } from './assignment-draft.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const fresh = (project, now) => project.sources.every(s => Date.parse(s.observedAt) <= Date.parse(now) && Date.parse(s.expiresAt) > Date.parse(now));
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const event = (state, kind, data, at) => state.events.push({ seq: state.events.length + 1, kind, data, at });

export function rejectionReviewHash(record) {
  const p = record?.provider;
  if (record?.status !== 'held' || !Number.isFinite(Date.parse(record.completedAt)) || record.retryRequestId
    || !p?.intentAt || !p.sessionId || !(p.reservedMicros > 0)
    || ![429, 503].includes(p.httpStatus) || p.rejection?.httpStatus !== p.httpStatus
    || !['rate_limit_exceeded', 'rate_limit_error', 'overloaded_error', 'api_error'].includes(p.rejection.errorCategory)
    || p.rejection.providerErrorCode === 'enforced_spend_limit_reached') return null;
  return digest({ id: record.id, inputHash: record.inputHash, contextRevision: record.contextRevision,
    judge: record.judge, completedAt: record.completedAt, provider: p });
}

export function initialState(project, { model, budgetMicros }) {
  validateProject(project);
  requireValue(model === 'anthropic/claude-opus-5' && Number.isSafeInteger(budgetMicros) && budgetMicros >= 0 && budgetMicros <= 5_000_000, 'PILOT_CONFIGURATION_INVALID');
  requireValue(project.sources.every(s => s.exposure === 'model_allowed'), 'CONTEXT_NOT_APPROVED_FOR_HOSTING');
  return { version: 1, project: { ...project, revision: digest(project) }, requests: {}, commitments: {}, events: [],
    model, budgetMicros, reservedMicros: 0, paused: false };
}

export class HostedSteward {
  constructor(store, judge, { now = () => new Date().toISOString(), coding = null } = {}) { this.store = store; this.judge = judge; this.now = now; this.coding = coding; }
  reviewPilot(input) { return reviewPilot(this.store, input, this.now()); }
  approvePilot(input) { return approvePilot(this.store, input, this.now()); }
  saveNote(input) { return saveNote(this.store, input, this.now()); }
  completeCommitment(input) { return completeCommitment(this.store, input, this.now()); }
  async resume() { return this.store.change(state => {
    requireValue(!Object.values(state.requests).some(r => ['thinking', 'held'].includes(r.status)) && !state.coding?.active, 'UNRESOLVED_MODEL_ATTEMPT');
    state.paused = false; if (state.coding) state.coding.paused = false;
    event(state, 'admission_resumed', {}, this.now()); return { paused: false };
  }); }
  reviewContinuation() { return reviewContinuation(this.store, this.now()); }
  approveContinuation(input) { return approveContinuation(this.store, input, this.now()); }
  previewContext(project) { return previewContext(this.store, project, this.now()); }
  applyContext(input) { return applyContext(this.store, input, this.now()); }
  async view() {
    const state = await this.store.read();
    let continuationAvailable = false;
    try { continuationPacket(state, this.now()); continuationAvailable = true; } catch { /* Fail closed until the run is verified and closed. */ }
    let continuationProblem = null;
    try { judgmentProject(state, this.now()); } catch (error) { continuationProblem = error.message; }
    return { followThrough: followThroughView(state), pilot: state.pilot ?? null, progress: progressView(state), monitor: state.monitor ? { lastCheckedAt: state.monitor.lastCheckedAt, lastError: state.monitor.lastError, notificationStatus: state.monitor.notificationStatus } : null, repeatableCoding: Boolean(this.coding?.config?.repeatable), continuationAvailable, continuationProblem, project: state.project, contextFresh: fresh(state.project, this.now()), judge: state.model,
      requests: Object.values(state.requests).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || (b.id ?? '').localeCompare(a.id ?? '')).slice(0, 50).map(r => ({ ...r, retryReviewHash: rejectionReviewHash(r) })), commitments: Object.values(state.commitments).filter(c => c.contextRevision === state.project.revision),
      historicalCommitments: Object.values(state.commitments).filter(c => c.contextRevision !== state.project.revision),
      providerAttempts: Object.values(state.requests).filter(r => r.provider).length, maxProviderAttempts: attemptLimit(state),
      budgetMicros: state.budgetMicros, reservedMicros: state.reservedMicros, paused: state.paused,
      codingEnabled: Boolean(this.coding?.enabled()), codingJobs: Object.values(state.coding?.jobs ?? {}), codingPaused: Boolean(state.coding?.paused) };
  }
  async propose({ requestId, projectId, message, expectedContextRevision, retryOf, rejectionHash, mode }) {
    requireValue(validId(requestId) && typeof projectId === 'string' && typeof message === 'string' && message.trim() && message.length <= 2000
      && (mode === undefined || mode === 'assignment_draft'), 'INVALID_REQUEST');
    requireValue((retryOf === undefined && rejectionHash === undefined) || (validId(retryOf) && typeof rejectionHash === 'string' && /^[a-f0-9]{64}$/.test(rejectionHash)), 'INVALID_REQUEST');
    // Drafting is part of the request identity; ordinary requests hash exactly as before.
    const inputHash = digest({ projectId, message, ...(mode ? { mode } : {}) });
    const start = await this.store.change(state => {
      const existing = Object.hasOwn(state.requests, requestId) ? state.requests[requestId] : undefined;
      if (existing) { requireValue(existing.inputHash === inputHash && existing.retryOf === retryOf && existing.rejectionHash === rejectionHash, 'REQUEST_ID_CONFLICT'); return { existing }; }
      requireValue(projectId === state.project.id && (expectedContextRevision === undefined || expectedContextRevision === state.project.revision), 'INVALID_REQUEST');
      requireValue(!state.paused && Object.keys(state.requests).length < 500
        && Object.values(state.requests).filter(r => r.provider).length < attemptLimit(state), 'ADMISSION_PAUSED');
      let failed;
      if (retryOf !== undefined) {
        failed = Object.hasOwn(state.requests, retryOf) ? state.requests[retryOf] : undefined;
        requireValue(rejectionHash === rejectionReviewHash(failed) && failed?.inputHash === inputHash
          && failed.projectId === projectId && failed.contextRevision === state.project.revision
          && failed.judge === state.model && expectedContextRevision === state.project.revision, 'RETRY_REVIEW_MISMATCH');
        const after = failed.provider.rejection.retryAfter;
        const retryAt = after?.kind === 'date' ? Date.parse(after.at) : after?.kind === 'seconds' ? Date.parse(failed.completedAt) + after.seconds * 1000 : 0;
        requireValue(Number.isFinite(retryAt) && Date.parse(this.now()) >= retryAt, 'RETRY_NOT_READY');
      }
      requireValue(!Object.values(state.requests).some(r => r !== failed && ['thinking', 'held'].includes(r.status)), 'UNRESOLVED_MODEL_ATTEMPT');
      requireValue(fresh(state.project, this.now()), 'CONTEXT_EXPIRED');
      requireValue(state.project.sources.every(s => s.exposure === 'model_allowed'), 'CONTEXT_NOT_APPROVED');
      const commitments = Object.values(state.commitments).filter(c => !c.completedAt && c.contextRevision === state.project.revision);
      const project = judgmentProject(state, this.now());
      const input = { request: message, project, commitments, hostedRequestId: requestId, ...(mode ? { mode } : {}) };
      requireValue(Buffer.byteLength(JSON.stringify(input)) <= 32768, 'CONTEXT_TOO_LARGE');
      const record = { id: requestId, inputHash, projectId, message, contextRevision: state.project.revision,
        contextSnapshot: project, judge: state.model, status: 'thinking', createdAt: this.now(), inputDigest: digest(input), ...(mode ? { mode } : {}) };
      if (failed) {
        record.retryOf = retryOf; record.rejectionHash = rejectionHash;
        failed.retryRequestId = requestId;
        event(state, 'rejected_judgment_retry_approved', { failedRequestId: retryOf, requestId, rejectionHash }, this.now());
      }
      state.requests[requestId] = record;
      event(state, 'judgment_intent', { requestId }, this.now());
      return { input };
    });
    if (start.existing) return start.existing;
    let proposal;
    try { proposal = await this.judge(start.input); } catch { /* Outcome may be unknown. Never replay. */ }
    return this.store.change(state => {
      const record = Object.hasOwn(state.requests, requestId) ? state.requests[requestId] : undefined;
      try {
        requireValue(proposal && record.provider?.intentAt && record.provider.sessionId && record.provider.reservedMicros > 0
          && state.reservedMicros >= record.provider.reservedMicros && record.provider.httpStatus >= 200 && record.provider.httpStatus < 300, 'NO_VERIFIED_PROVIDER_RESULT');
        // The optional assignment draft is validated separately; the proposal (and its
        // hash) keeps the existing strict shape. Semantic draft problems are flagged,
        // not fatal; a malformed draft invalidates the output like any malformed field.
        const { draft = null, ...core } = proposal;
        validateProposal(core, record.contextSnapshot);
        if (draft !== null && record.mode !== 'assignment_draft') record.draftIgnored = 'not_requested';
        else if (draft !== null && core.kind === 'plan') {
          record.assignmentDraft = validateAssignmentDraft(draft, { project: record.contextSnapshot, request: record.message, proposal: core });
        } else if (draft !== null) record.draftIgnored = 'not_a_plan';
        record.proposal = core;
        record.proposalHash = digest({ projectId, contextRevision: record.contextRevision, proposal: core });
        record.status = proposal.kind === 'clarify' ? 'needs_context' : 'awaiting_approval';
      } catch {
        record.status = record.provider?.intentAt ? 'held' : 'not_sent';
        record.failure = record.provider?.intentAt ? 'judgment_unavailable_or_invalid' : 'provider_not_admitted';
        if (record.status === 'not_sent' && record.retryOf && state.requests[record.retryOf]?.retryRequestId === record.id) {
          delete state.requests[record.retryOf].retryRequestId;
        }
      }
      record.completedAt = this.now();
      event(state, 'judgment_observed', { requestId, status: record.status }, this.now());
      return record;
    });
  }
  async approve({ requestId, proposalHash }) {
    requireValue(validId(requestId), 'INVALID_REQUEST');
    return this.store.change(state => {
      const record = Object.hasOwn(state.requests, requestId) ? state.requests[requestId] : undefined;
      requireValue(record && record.proposalHash === proposalHash && record.contextRevision === state.project.revision && fresh(state.project, this.now()) && fresh(record.contextSnapshot, this.now()), 'APPROVAL_MISMATCH');
      requireValue(['awaiting_approval', 'approved'].includes(record.status), 'APPROVAL_UNAVAILABLE');
      // Coding approval/dispatch is deliberately not exposed until a new fixed
      // routine assignment has been approved and configured by the operator.
      requireValue(record.proposal.kind === 'commitment', 'CODING_NOT_ENABLED');
      if (record.status === 'approved') return record;
      record.status = 'approved'; record.approvedAt = this.now();
      state.commitments[requestId] = { id: requestId, projectId: state.project.id, title: record.proposal.title, rationale: record.proposal.rationale,
        citations: record.proposal.citations, contextRevision: record.contextRevision, approvedAt: record.approvedAt };
      event(state, 'commitment_approved', { requestId, proposalHash }, this.now());
      return record;
    });
  }
  async pause() { return this.store.change(state => { state.paused = true; event(state, 'admission_paused', {}, this.now()); if (state.coding) { state.coding.paused = true; if (state.coding.active) state.coding.jobs[state.coding.active].stopRequested = true; } return { paused: true }; }); }
}
