import { createHash } from 'node:crypto';
/**
 * Validation and composition for Eve's optional assignment draft.
 *
 * The draft arrives inside the single existing judgment (a `plan` proposal). Every
 * model-written field is untrusted: source IDs must exist in the request's approved
 * context snapshot, and file paths must be syntactically exact and literally named in
 * that approved context (source content or an approved coding candidate). Anything
 * that fails is flagged for the owner, never silently dropped and never prefilled.
 * The owner's outcome is the verbatim request text supplied by the application, not
 * a model paraphrase. The draft only prefills the existing editable assignment form;
 * preparing, reviewing and the exact dispatch approval are unchanged.
 */
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const DRAFT_LIMITS = Object.freeze({ sourceRefs: 4, files: 8, acceptanceExamples: 4, verification: 4, why: 120, example: 200, step: 160, path: 200, specText: 4000 });
export const SCOPE_GAP_QUESTION = 'Which existing files may change for this outcome? None of the suggested files is named in the approved project context.';
export const CONTEXT_GAP_QUESTION = 'Which referenced context must the coding partner see? The referenced sources do not fit in one assignment.';

const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const plain = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const clip = (value, max = 120) => String(value).slice(0, max);

/** Same syntax rule as the dispatch spec: explicit relative file paths only. */
export function pathSyntaxOk(path) {
  return typeof path === 'string' && path.length <= DRAFT_LIMITS.path && /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/.test(path)
    && !path.includes('..') && !path.startsWith('/') && !path.startsWith('.') && !path.includes('/.');
}
const tokens = content => new Set(String(content).split(/[\s,;:()`'"<>[\]{}|*]+/).map(t => t.replace(/\.+$/, '')).filter(Boolean));
/** Where the approved context names this exact path, or null. No repository reads. */
export function pathEvidence(path, project) {
  for (const candidate of project?.codingCandidates ?? []) {
    if (candidate.spec?.allowedPaths?.includes(path)) return { kind: 'coding_candidate', id: candidate.id };
  }
  for (const source of project?.sources ?? []) {
    if (tokens(source.content).has(path)) return { kind: 'source', id: source.id, revision: source.revision };
  }
  return null;
}

/** Structural check mirroring schema.js, for judges that are not schema-enforced. */
export function draftShapeOk(draft) {
  const L = DRAFT_LIMITS;
  return plain(draft, ['sourceRefs', 'files', 'acceptanceExamples', 'verification'])
    && Array.isArray(draft.sourceRefs) && draft.sourceRefs.length >= 1 && draft.sourceRefs.length <= L.sourceRefs
    && draft.sourceRefs.every(r => plain(r, ['sourceId', 'why']) && text(r.sourceId, 64) && text(r.why, L.why))
    && Array.isArray(draft.files) && draft.files.length <= L.files
    && draft.files.every(f => plain(f, ['path', 'why']) && text(f.path, L.path) && text(f.why, L.why))
    && Array.isArray(draft.acceptanceExamples) && draft.acceptanceExamples.length >= 1 && draft.acceptanceExamples.length <= L.acceptanceExamples
    && draft.acceptanceExamples.every(e => text(e, L.example))
    && Array.isArray(draft.verification) && draft.verification.length >= 1 && draft.verification.length <= L.verification
    && draft.verification.every(s => text(s, L.step));
}

/** Deterministic text for the existing objective / acceptance / allowedPaths fields. */
export function composeAssignment(draft, project) {
  const refs = draft.sourceRefs.map(r => {
    const source = project.sources.find(s => s.id === r.sourceId);
    return `- [${source.id}] ${source.title} (revision ${source.revision}): ${source.content}`;
  });
  const objective = [draft.outcome, '', `Approved context (project revision ${String(project.revision ?? '').slice(0, 12)}):`, ...refs].join('\n');
  const acceptance = ['Acceptance examples:', ...draft.acceptanceExamples.map((e, i) => `${i + 1}. ${e}`), '',
    'Verification steps:', ...draft.verification.map((s, i) => `${i + 1}. ${s}`)].join('\n');
  return { objective, acceptance, allowedPaths: draft.files.map(f => f.path).sort() };
}

/**
 * @param {object} draft untrusted model draft (already shape-checked)
 * @param {{ project: object, request: string, proposal: object }} input approved snapshot,
 *   verbatim owner request, and the already-validated plan proposal
 */
export function validateAssignmentDraft(draft, { project, request, proposal }) {
  if (!draftShapeOk(draft)) throw new Error('INVALID_ASSIGNMENT_DRAFT');
  const flags = [];
  const sourceRefs = [];
  for (const ref of draft.sourceRefs) {
    const source = project.sources.find(s => s.id === ref.sourceId);
    if (!source) { flags.push({ field: 'sourceRefs', value: clip(ref.sourceId, 64), reason: 'unknown_source' }); continue; }
    if (!sourceRefs.some(r => r.sourceId === source.id)) sourceRefs.push({ sourceId: source.id, title: source.title, revision: source.revision, why: ref.why, origin: 'eve' });
  }
  // Context Eve relied on for the plan is necessary scope; keep it rather than drop it.
  for (const id of proposal.citations) {
    const source = project.sources.find(s => s.id === id);
    if (source && !sourceRefs.some(r => r.sourceId === id)) sourceRefs.push({ sourceId: id, title: source.title, revision: source.revision, why: null, origin: 'plan_citation' });
  }
  const files = [];
  for (const file of draft.files) {
    if (!pathSyntaxOk(file.path)) { flags.push({ field: 'files', value: clip(file.path), reason: 'invalid_path', why: file.why }); continue; }
    if (files.some(f => f.path === file.path)) continue;
    const evidence = pathEvidence(file.path, project);
    if (!evidence) { flags.push({ field: 'files', value: file.path, reason: 'not_in_approved_context', why: file.why }); continue; }
    files.push({ path: file.path, why: file.why, evidence });
  }
  const result = { version: 1, outcome: request, contextRevision: project.revision, sourceRefs, files,
    acceptanceExamples: [...draft.acceptanceExamples], verification: [...draft.verification], flags, gap: null };
  result.composed = composeAssignment(result, project);
  if (!files.length) result.gap = SCOPE_GAP_QUESTION;
  else if (result.composed.objective.length > DRAFT_LIMITS.specText || result.composed.acceptance.length > DRAFT_LIMITS.specText) result.gap = CONTEXT_GAP_QUESTION;
  result.draftHash = hash(result);
  return result;
}

/** Owner-facing provenance for a prepared assignment. Informational; never grants scope. */
export function assignmentProvenance({ objective, acceptance, allowedPaths }, project, source) {
  const unverifiedPaths = allowedPaths.filter(p => !pathEvidence(p, project));
  const draft = source?.assignmentDraft;
  if (!draft) return { unverifiedPaths };
  const submitted = { objective, acceptance, allowedPaths: [...allowedPaths].sort() };
  return { unverifiedPaths, fromDraft: draft.draftHash, editedByOwner: hash(submitted) !== hash(draft.composed),
    outcomeIntact: objective.includes(draft.outcome) };
}
