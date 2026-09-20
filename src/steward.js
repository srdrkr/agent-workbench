import { validateProject, validateProposal } from './steward-policy.js';
import { createHash } from 'node:crypto';
import { Probe } from './probe.js';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw new Error(message); };
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

export class Steward {
  constructor(path, { now = () => new Date().toISOString(), judge, judgeName = 'scripted demo' } = {}) {
    this.probe = new Probe(path, { now });
    this.now = now; this.judge = judge; this.judgeName = judgeName;
    this.db = this.probe.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS steward_project (id TEXT PRIMARY KEY, revision TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steward_requests (id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steward_commitments (id TEXT PRIMARY KEY, record TEXT NOT NULL);`);
  }
  close() { this.probe.close(); }
  project() {
    const row = this.db.prepare('SELECT record FROM steward_project LIMIT 1').get();
    if (!row) fail('No approved project context');
    return JSON.parse(row.record);
  }
  // Only a trusted local operator can import context. This is not an agent or HTTP tool.
  importProject(input) {
    validateProject(input);
    if (input.codingCandidates.some(c => c.spec.mode !== 'synthetic')) fail('Local Steward supports synthetic handoff only');
    const project = { ...copy(input), revision: digest(input) };
    this.probe.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM steward_project LIMIT 1').get();
      if (existing && existing.id !== project.id) fail('This Steward is scoped to one project');
      this.db.prepare('INSERT OR REPLACE INTO steward_project VALUES (?,?,?)').run(project.id, project.revision, JSON.stringify(project));
      this.probe.event(null, 'context_imported', { projectId: project.id, revision: project.revision });
    });
    return project;
  }
  fresh(project) {
    return project.sources.every(s => Date.parse(s.observedAt) <= Date.parse(this.now()) && Date.parse(s.expiresAt) > Date.parse(this.now()));
  }
  request(id) {
    const row = this.db.prepare('SELECT record FROM steward_requests WHERE id=?').get(id);
    if (!row) fail('Unknown request');
    return JSON.parse(row.record);
  }
  save(record) { this.db.prepare('UPDATE steward_requests SET record=? WHERE id=?').run(JSON.stringify(record), record.id); }
  async propose({ requestId, projectId, message }) {
    if (!id(requestId) || !text(message, 2000)) fail('Invalid conversational input');
    const project = this.project();
    if (projectId !== project.id) fail('Project access denied');
    const inputHash = digest({ projectId, message });
    const existing = this.db.prepare('SELECT input_hash FROM steward_requests WHERE id=?').get(requestId);
    if (existing) {
      if (existing.input_hash !== inputHash) fail('Request ID reused with different input');
      return this.request(requestId); // Also holds interrupted model calls; no hidden replay.
    }
    const record = { id: requestId, projectId, contextRevision: project.revision, message,
      contextSnapshot: copy(project), createdAt: this.now(), status: 'thinking', judge: this.judgeName };
    this.probe.transaction(() => {
      this.db.prepare('INSERT INTO steward_requests VALUES (?,?,?)').run(requestId, inputHash, JSON.stringify(record));
      this.probe.event(null, 'steward_requested', { requestId, contextRevision: project.revision, judge: this.judgeName });
    });
    try {
      let proposal;
      if (!this.fresh(project)) {
        proposal = { kind: 'clarify', candidateId: null, title: 'Refresh the project brief',
          rationale: 'At least one source is expired or dated in the future. A dependent action needs current context.',
          citations: project.sources.map(s => s.id), question: 'Which project facts should replace the expired context?' };
      } else {
        proposal = await this.judge({ request: message, project: copy(project), commitments: this.commitments() });
      }
      this.validateProposal(proposal, project);
      if (proposal.kind === 'coding') {
        const candidate = project.codingCandidates.find(c => c.id === proposal.candidateId);
        const taskId = `st-${digest({ project: project.id, revision: project.revision, candidate: candidate.id }).slice(0, 32)}`;
        const task = this.probe.prepare({ ...candidate.spec, taskId });
        record.taskId = taskId; record.scopeHash = task.scopeHash;
      }
      record.proposal = copy(proposal);
      record.proposalHash = digest({ projectId, contextRevision: record.contextRevision, proposal, taskId: record.taskId });
      record.status = proposal.kind === 'clarify' ? 'needs_context' : 'awaiting_approval';
    } catch {
      // Provider/parser errors may contain prompts or credentials. Persist a fixed label only.
      record.status = 'failed'; record.failure = 'judgment_unavailable_or_invalid';
    }
    record.completedAt = this.now();
    this.probe.transaction(() => {
      this.save(record);
      this.probe.event(record.taskId ?? null, 'steward_proposed', { requestId, status: record.status, proposalHash: record.proposalHash ?? null });
    });
    return record;
  }
  validateProposal(p, project) {
    validateProposal(p, project);
  }
  approve(requestId, { proposalHash, owner }) {
    if (owner !== 'local-owner') fail('Authenticated owner required');
    const record = this.request(requestId);
    if (record.proposalHash !== proposalHash) fail('Approval does not match proposal');
    const project = this.project();
    if (record.contextRevision !== project.revision || !this.fresh(project)) fail('Context changed or expired; request a new proposal');
    if (!['awaiting_approval', 'approved'].includes(record.status)) fail('Proposal cannot be approved');
    if (record.taskId && record.approval && Date.parse(record.approval.expiresAt) <= Date.parse(this.now())) fail('Approval expired; request a new proposal');
    if (!record.approval) {
      record.approval = { owner, approvedAt: this.now(), expiresAt: new Date(Date.parse(this.now()) + 15 * 60000).toISOString(), proposalHash };
      record.status = 'approved';
      this.probe.transaction(() => {
        this.save(record);
        if (record.proposal.kind === 'commitment') {
          const commitment = { id: requestId, title: record.proposal.title, rationale: record.proposal.rationale,
            citations: record.proposal.citations, contextRevision: record.contextRevision, approvedAt: record.approval.approvedAt };
          this.db.prepare('INSERT OR IGNORE INTO steward_commitments VALUES (?,?)').run(requestId, JSON.stringify(commitment));
        }
        this.probe.event(record.taskId ?? null, 'proposal_approved', { requestId, ...record.approval });
      });
    }
    // A crash between the approval receipt and task authorization is recoverable by the same request.
    if (record.taskId) {
      const task = this.probe.get(record.taskId);
      if (task.dispatch === 'not_sent' && (!task.approval || Date.parse(task.approval.expiresAt) <= Date.parse(this.now()))) this.probe.authorize(record.taskId, {
        scopeHash: task.scopeHash, action: 'one_routine_fire', approvedBy: owner,
        expiresAt: record.approval.expiresAt, extraUsageDisabled: true, scopeVerified: true,
        incrementalSpendUsd: 0, mode: 'synthetic',
      });
    }
    return record;
  }
  async dispatch(requestId, { proposalHash, owner }, transport) {
    if (typeof transport !== 'function') fail('Explicit synthetic transport required');
    const record = this.approve(requestId, { proposalHash, owner });
    if (!record.taskId) fail('This proposal has no coding handoff');
    const task = this.probe.get(record.taskId);
    if (task.spec.mode !== 'synthetic') fail('Live coding is not enabled in the local app');
    return this.probe.dispatch(record.taskId, { token: 'synthetic-local-fixture', fetchImpl: transport });
  }
  commitments() { return this.db.prepare('SELECT record FROM steward_commitments ORDER BY rowid DESC').all().map(r => JSON.parse(r.record)); }
  view() {
    const project = this.project();
    return { project, contextFresh: this.fresh(project), judge: this.judgeName, mode: 'synthetic',
      controls: this.probe.controls(), commitments: this.commitments(),
      requests: this.db.prepare('SELECT record FROM steward_requests ORDER BY rowid DESC LIMIT 50').all().map(r => {
        const record = JSON.parse(r.record);
        return { ...record, task: record.taskId ? this.probe.get(record.taskId) : null };
      }) };
  }
}
