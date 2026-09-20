import { createHash } from 'node:crypto';
import { previewContext, applyContext } from './context.js';
import { validateProject, validateProposal } from '../../../src/steward-policy.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const fresh = (project, now) => project.sources.every(s => Date.parse(s.observedAt) <= Date.parse(now) && Date.parse(s.expiresAt) > Date.parse(now));
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const event = (state, kind, data, at) => state.events.push({ seq: state.events.length + 1, kind, data, at });

export function initialState(project, { model, budgetMicros }) {
  validateProject(project);
  requireValue(model === 'anthropic/claude-opus-5' && Number.isSafeInteger(budgetMicros) && budgetMicros >= 0 && budgetMicros <= 5_000_000, 'PILOT_CONFIGURATION_INVALID');
  requireValue(project.sources.every(s => s.exposure === 'model_allowed'), 'CONTEXT_NOT_APPROVED_FOR_HOSTING');
  return { version: 1, project: { ...project, revision: digest(project) }, requests: {}, commitments: {}, events: [],
    model, budgetMicros, reservedMicros: 0, paused: false };
}

export class HostedSteward {
  constructor(store, judge, { now = () => new Date().toISOString(), coding = null } = {}) { this.store = store; this.judge = judge; this.now = now; this.coding = coding; }
  previewContext(project) { return previewContext(this.store, project, this.now()); }
  applyContext(input) { return applyContext(this.store, input, this.now()); }
  async view() {
    const state = await this.store.read();
    return { project: state.project, contextFresh: fresh(state.project, this.now()), judge: state.model,
      requests: Object.values(state.requests).reverse().slice(0, 50), commitments: Object.values(state.commitments).filter(c => c.contextRevision === state.project.revision),
      historicalCommitments: Object.values(state.commitments).filter(c => c.contextRevision !== state.project.revision),
      providerAttempts: Object.values(state.requests).filter(r => r.provider).length, maxProviderAttempts: 5,
      budgetMicros: state.budgetMicros, reservedMicros: state.reservedMicros, paused: state.paused,
      codingEnabled: Boolean(this.coding?.enabled()), codingJobs: Object.values(state.coding?.jobs ?? {}), codingPaused: Boolean(state.coding?.paused) };
  }
  async propose({ requestId, projectId, message, expectedContextRevision }) {
    requireValue(validId(requestId) && typeof projectId === 'string' && typeof message === 'string' && message.trim() && message.length <= 2000, 'INVALID_REQUEST');
    const inputHash = digest({ projectId, message });
    const start = await this.store.change(state => {
      const existing = Object.hasOwn(state.requests, requestId) ? state.requests[requestId] : undefined;
      if (existing) { requireValue(existing.inputHash === inputHash, 'REQUEST_ID_CONFLICT'); return { existing }; }
      requireValue(projectId === state.project.id && (expectedContextRevision === undefined || expectedContextRevision === state.project.revision), 'INVALID_REQUEST');
      requireValue(!state.paused && Object.keys(state.requests).length < 500
        && Object.values(state.requests).filter(r => r.provider).length < 5, 'ADMISSION_PAUSED');
      requireValue(!Object.values(state.requests).some(r => ['thinking', 'held'].includes(r.status)), 'UNRESOLVED_MODEL_ATTEMPT');
      requireValue(fresh(state.project, this.now()), 'CONTEXT_EXPIRED');
      requireValue(state.project.sources.every(s => s.exposure === 'model_allowed'), 'CONTEXT_NOT_APPROVED');
      const commitments = Object.values(state.commitments).filter(c => c.contextRevision === state.project.revision);
      const input = { request: message, project: state.project, commitments, hostedRequestId: requestId };
      requireValue(Buffer.byteLength(JSON.stringify(input)) <= 32768, 'CONTEXT_TOO_LARGE');
      const record = { id: requestId, inputHash, projectId, message, contextRevision: state.project.revision,
        contextSnapshot: state.project, judge: state.model, status: 'thinking', createdAt: this.now(), inputDigest: digest(input) };
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
        validateProposal(proposal, record.contextSnapshot);
        record.proposal = proposal;
        record.proposalHash = digest({ projectId, contextRevision: record.contextRevision, proposal });
        record.status = proposal.kind === 'clarify' ? 'needs_context' : 'awaiting_approval';
      } catch {
        record.status = 'held'; record.failure = 'judgment_unavailable_or_invalid';
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
      requireValue(record && record.proposalHash === proposalHash && record.contextRevision === state.project.revision && fresh(state.project, this.now()), 'APPROVAL_MISMATCH');
      requireValue(['awaiting_approval', 'approved'].includes(record.status), 'APPROVAL_UNAVAILABLE');
      // Coding approval/dispatch is deliberately not exposed until a new fixed
      // routine assignment has been approved and configured by the operator.
      requireValue(record.proposal.kind === 'commitment', 'CODING_NOT_ENABLED');
      if (record.status === 'approved') return record;
      record.status = 'approved'; record.approvedAt = this.now();
      state.commitments[requestId] = { id: requestId, title: record.proposal.title, rationale: record.proposal.rationale,
        citations: record.proposal.citations, contextRevision: record.contextRevision, approvedAt: record.approvedAt };
      event(state, 'commitment_approved', { requestId, proposalHash }, this.now());
      return record;
    });
  }
  async pause() { return this.store.change(state => { state.paused = true; event(state, 'admission_paused', {}, this.now()); if (state.coding) { state.coding.paused = true; if (state.coding.active) state.coding.jobs[state.coding.active].stopRequested = true; } return { paused: true }; }); }
}
