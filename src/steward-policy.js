import { validatedSpec } from './task-policy.js';
const fail = message => { throw new Error(message); };
const text = (value, max = 4000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const id = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).every(key => keys.includes(key));

export function validateProject(input) {
    if (!fields(input, ['id', 'name', 'objective', 'sources', 'codingCandidates']) || !id(input.id) ||
      !text(input.name, 120) || !text(input.objective) || !Array.isArray(input.sources) ||
      input.sources.length < 1 || input.sources.length > 12 || !Array.isArray(input.codingCandidates) ||
      input.codingCandidates.length > 8) fail('Invalid project context');
    const ids = new Set();
    for (const s of input.sources) {
      if (!fields(s, ['id', 'title', 'revision', 'observedAt', 'expiresAt', 'content', 'exposure']) ||
        !id(s.id) || ids.has(s.id) || !text(s.title, 160) || !text(s.revision, 160) || !text(s.content) ||
        !Number.isFinite(Date.parse(s.observedAt)) || !Number.isFinite(Date.parse(s.expiresAt)) ||
        Date.parse(s.expiresAt) <= Date.parse(s.observedAt) ||
        !['local_only', 'model_allowed'].includes(s.exposure)) fail('Invalid context source');
      ids.add(s.id);
    }
    const candidates = new Set();
    for (const c of input.codingCandidates) {
      if (!fields(c, ['id', 'title', 'sourceIds', 'spec']) || !id(c.id) || candidates.has(c.id) ||
        !text(c.title, 160) || !Array.isArray(c.sourceIds) || !c.sourceIds.length || c.sourceIds.some(s => !ids.has(s))) fail('Invalid coding candidate');
      candidates.add(c.id);
      validatedSpec(c.spec);
    }
}

export function validateProposal(p, project) {
    if (!fields(p, ['kind', 'candidateId', 'title', 'rationale', 'citations', 'question']) ||
      !['coding', 'commitment', 'clarify'].includes(p.kind) || !text(p.title, 240) || !text(p.rationale, 2000) ||
      !Array.isArray(p.citations) || !p.citations.length || p.citations.length > 12 ||
      p.citations.some(s => !project.sources.some(source => source.id === s)) ||
      (p.kind === 'clarify' ? !text(p.question, 500) : p.question !== null)) fail('Invalid proposal');
    if (p.kind === 'coding') {
      const candidate = project.codingCandidates.find(c => c.id === p.candidateId);
      if (!candidate || !candidate.sourceIds.every(s => p.citations.includes(s))) fail('Unsupported coding scope');
    } else if (p.candidateId !== null) fail('Invalid proposal target');
}
