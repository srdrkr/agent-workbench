/**
 * Synthetic data for assignment drafting: an approved project whose brief names a
 * small file map, a fixed synthetic coding connection, and stub judge responses in
 * the draft shape (schema.js assignmentDraftSchema). Used by unit tests and the
 * browser verifier. Fixtures show the application's handling, not model judgment.
 */
export const DRAFT_CLOCK_START = '2026-09-19T12:00:00.000Z';
export const DRAFT_CONTEXT_EXPIRES = '2026-09-26T00:00:00Z';
export const DRAFT_BASE_SHA = '1'.repeat(40);

export const ASSIGNMENT_PROJECT = Object.freeze({
  id: 'link-quality',
  name: 'Help centre links',
  objective: 'Make generated help-centre links predictable. Finish the known normalization defect before taking on new features.',
  sources: [
    { id: 'brief', title: 'Synthetic project brief', revision: 'draft-1', observedAt: '2026-09-17T00:00:00Z', expiresAt: DRAFT_CONTEXT_EXPIRES, exposure: 'model_allowed',
      content: 'Synthetic scenario. Current priority, settled by the owner on 2026-09-17: normalize pasted whitespace in link slugs. Do not change the publishing workflow or introduce dependencies.' },
    { id: 'repository-map', title: 'Repository file map (owner-approved listing)', revision: 'draft-1', observedAt: '2026-09-17T00:00:00Z', expiresAt: DRAFT_CONTEXT_EXPIRES, exposure: 'model_allowed',
      content: 'Files at main: src/slug.js generates slugs; test/slug.test.js holds the node --test cases; src/publish.js is the publishing workflow and is out of scope; package.json.' },
    { id: 'acceptance', title: 'Normalization acceptance', revision: 'draft-1', observedAt: '2026-09-17T00:00:00Z', expiresAt: DRAFT_CONTEXT_EXPIRES, exposure: 'model_allowed',
      content: 'Completion evidence: passing node --test checks and a draft PR. Leading or trailing whitespace and repeated spaces or hyphens collapse to single hyphens.' },
  ],
  codingCandidates: [],
});

export const DRAFT_CODING_SPEC = Object.freeze({
  taskId: 'synthetic-connection', repository: 'example-owner/workbench-routine-sandbox', visibility: 'public', routineId: 'trig_SYNTHETIC',
  baseBranch: 'main', baseSha: DRAFT_BASE_SHA, objective: 'Fixed synthetic connection; each assignment supplies its own task.',
  acceptance: 'Each assignment supplies its own acceptance.', allowedPaths: ['src/slug.js'], requiredChecks: [{ name: 'test', appId: 15368 }], mode: 'synthetic',
});

/** Read-only GitHub stand-in for the fixed connection. No network. */
export const draftRepositoryReader = async path => (path.includes('/commits/') ? { sha: DRAFT_BASE_SHA }
  : { full_name: DRAFT_CODING_SPEC.repository, private: false, default_branch: DRAFT_CODING_SPEC.baseBranch });

export const SUFFICIENT_REQUEST = 'Draft a coding assignment: slugs made from pasted titles with extra spaces should come out as clean single-hyphen links.';
export const GAP_REQUEST = 'Draft a coding assignment to export the link report.';
export const UNSCOPED_REQUEST = 'Draft a coding assignment to add link previews.';

export const DRAFT_OK = Object.freeze({
  kind: 'plan', candidateId: null,
  title: 'Collapse pasted whitespace in generated slugs',
  rationale: 'The brief settles slug whitespace normalization as the current priority, and the approved file map names the slug module and its tests.',
  citations: ['brief', 'repository-map', 'acceptance'], question: null,
  draft: {
    sourceRefs: [{ sourceId: 'brief', why: 'Settled priority and constraints' }, { sourceId: 'repository-map', why: 'Names the slug module and its tests' }],
    files: [{ path: 'src/slug.js', why: 'Slug generation' }, { path: 'test/slug.test.js', why: 'Cases for the new behaviour' }],
    acceptanceExamples: ['"  Hello   World " becomes "hello-world"', '"a -- b" becomes "a-b"'],
    verification: ['Run node --test and confirm it passes', 'Confirm src/publish.js is unchanged'],
  },
});

/** Same plan, plus an unknown source, a path the brief never names, and an invalid path. */
export const DRAFT_WITH_INVALID = Object.freeze({
  ...DRAFT_OK,
  draft: {
    ...DRAFT_OK.draft,
    sourceRefs: [...DRAFT_OK.draft.sourceRefs, { sourceId: 'roadmap', why: 'Invented source' }],
    files: [...DRAFT_OK.draft.files, { path: 'src/links/format.js', why: 'Guessed helper' }, { path: '../secrets.env', why: 'Outside the repository' }],
  },
});

/** No suggested file is named in the approved context: the application asks one question. */
export const DRAFT_NO_SCOPE = Object.freeze({
  kind: 'plan', candidateId: null, title: 'Add link previews',
  rationale: 'Previews are not covered by the approved file map; the scope needs inspection.',
  citations: ['brief'], question: null,
  draft: { sourceRefs: [{ sourceId: 'brief', why: 'Current priority' }], files: [{ path: 'src/preview.js', why: 'Guessed module' }],
    acceptanceExamples: ['A link shows a preview card'], verification: ['Run node --test'] },
});

/** Missing fact: exactly one focused question, no draft. */
export const DRAFT_GAP = Object.freeze({
  kind: 'clarify', candidateId: null, title: 'Choose the export format',
  rationale: 'The approved brief does not mention a link report or its format.',
  citations: ['brief'], question: 'Which format should the link report export use: CSV or JSON?', draft: null,
});
