import test from 'node:test';
import assert from 'node:assert/strict';
import { TestPool } from './pg-fixture.js';
import { HostedStore, stateSchema } from '../hosted/store.js';
import { HostedSteward, initialState, digest } from '../hosted/steward.js';
import { HostedCoding } from '../hosted/coding.js';
import { proposalSchema, draftProposalSchema } from '../schema.js';
import { validateAssignmentDraft, draftShapeOk, pathEvidence, pathSyntaxOk, SCOPE_GAP_QUESTION, composeAssignment } from '../hosted/assignment-draft.js';
import { ASSIGNMENT_PROJECT, DRAFT_CODING_SPEC, DRAFT_CLOCK_START, draftRepositoryReader, SUFFICIENT_REQUEST, GAP_REQUEST, UNSCOPED_REQUEST,
  DRAFT_OK, DRAFT_WITH_INVALID, DRAFT_NO_SCOPE, DRAFT_GAP } from './assignment-draft-fixture.js';

const project = { ...structuredClone(ASSIGNMENT_PROJECT), revision: 'rev-draft-test' };
const core = p => { const { draft, ...rest } = p; return rest; };

test('a sufficient draft keeps the owner outcome verbatim and only context-named files', () => {
  const d = validateAssignmentDraft(DRAFT_OK.draft, { project, request: SUFFICIENT_REQUEST, proposal: core(DRAFT_OK) });
  assert.equal(d.outcome, SUFFICIENT_REQUEST);
  assert.deepEqual(d.files.map(f => [f.path, f.evidence.id]), [['src/slug.js', 'repository-map'], ['test/slug.test.js', 'repository-map']]);
  assert.deepEqual(d.sourceRefs.map(r => [r.sourceId, r.origin]), [['brief', 'eve'], ['repository-map', 'eve'], ['acceptance', 'plan_citation']]);
  assert.deepEqual(d.flags, []); assert.equal(d.gap, null);
  assert.ok(d.composed.objective.startsWith(`${SUFFICIENT_REQUEST}\n`));
  for (const s of project.sources) assert.ok(d.composed.objective.includes(s.content), `context kept: ${s.id}`);
  assert.match(d.composed.acceptance, /Acceptance examples:\n1\. "  Hello   World " becomes "hello-world"/);
  assert.match(d.composed.acceptance, /Verification steps:\n1\. Run node --test/);
  assert.deepEqual(d.composed.allowedPaths, ['src/slug.js', 'test/slug.test.js']);
  assert.match(d.draftHash, /^[a-f0-9]{64}$/);
});

test('unknown sources, unnamed paths and invalid paths are flagged, never prefilled', () => {
  const d = validateAssignmentDraft(DRAFT_WITH_INVALID.draft, { project, request: SUFFICIENT_REQUEST, proposal: core(DRAFT_WITH_INVALID) });
  assert.deepEqual(d.flags.map(f => [f.value, f.reason]), [['roadmap', 'unknown_source'], ['src/links/format.js', 'not_in_approved_context'], ['../secrets.env', 'invalid_path']]);
  assert.deepEqual(d.composed.allowedPaths, ['src/slug.js', 'test/slug.test.js']);
  assert.ok(!d.composed.objective.includes('roadmap'));
});

test('an empty verified scope becomes exactly one focused question', () => {
  const d = validateAssignmentDraft(DRAFT_NO_SCOPE.draft, { project, request: UNSCOPED_REQUEST, proposal: core(DRAFT_NO_SCOPE) });
  assert.equal(d.files.length, 0); assert.equal(d.gap, SCOPE_GAP_QUESTION);
  assert.equal((d.gap.match(/\?/g) ?? []).length, 1);
  assert.deepEqual(d.flags.map(f => f.reason), ['not_in_approved_context']);
});

test('path evidence requires an exact token in approved context or a candidate scope', () => {
  assert.deepEqual(pathEvidence('src/slug.js', project), { kind: 'source', id: 'repository-map', revision: 'draft-1' });
  assert.equal(pathEvidence('slug.js', project), null);
  assert.equal(pathEvidence('src/slug.jsx', project), null);
  assert.equal(pathEvidence('package.json', project)?.id, 'repository-map');
  const withCandidate = { ...project, codingCandidates: [{ id: 'c', title: 't', sourceIds: ['brief'], spec: { allowedPaths: ['lib/x.js'] } }] };
  assert.deepEqual(pathEvidence('lib/x.js', withCandidate), { kind: 'coding_candidate', id: 'c' });
  for (const bad of ['../a.js', '/etc/passwd.txt', '.env.js', 'src/.hidden.js', 'src/dir', 'a b.js']) assert.equal(pathSyntaxOk(bad), false, bad);
});

test('draft shape is bounded and strict; the schema stays compatible with draft-free proposals', () => {
  assert.equal(draftShapeOk(DRAFT_OK.draft), true);
  assert.equal(draftShapeOk({ ...DRAFT_OK.draft, extra: 1 }), false);
  assert.equal(draftShapeOk({ ...DRAFT_OK.draft, files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.js`, why: 'x' })) }), false);
  assert.equal(draftShapeOk({ ...DRAFT_OK.draft, acceptanceExamples: [] }), false);
  assert.throws(() => validateAssignmentDraft({ ...DRAFT_OK.draft, authority: 'merge' }, { project, request: 'x', proposal: core(DRAFT_OK) }), /INVALID_ASSIGNMENT_DRAFT/);
  assert.equal(draftProposalSchema.safeParse(DRAFT_OK).success, true);
  assert.equal(proposalSchema.safeParse(core(DRAFT_OK)).success, true);
  assert.equal(draftProposalSchema.safeParse(DRAFT_GAP).success, true);
  assert.equal(draftProposalSchema.safeParse({ ...DRAFT_OK, authority: 'merge' }).success, false, 'extended schema stays strict');
  assert.equal(draftProposalSchema.safeParse({ ...DRAFT_OK, draft: { ...DRAFT_OK.draft, extra: true } }).success, false);
  assert.equal(draftProposalSchema.safeParse({ ...DRAFT_OK, draft: { ...DRAFT_OK.draft, files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.js`, why: 'x' })) } }).success, false);
});

test('composition does not truncate context: oversized context becomes a question instead', () => {
  const big = { ...project, sources: project.sources.map(s => ({ ...s, content: `${s.content} ${'x'.repeat(1500)} src/slug.js` })) };
  const d = validateAssignmentDraft(DRAFT_OK.draft, { project: big, request: SUFFICIENT_REQUEST, proposal: core(DRAFT_OK) });
  assert.ok(d.composed.objective.length > 4000); assert.match(d.gap, /^Which referenced context/);
  assert.equal(composeAssignment(d, big).objective, d.composed.objective);
});

async function world(t, response = DRAFT_OK, start = DRAFT_CLOCK_START) {
  const pool = new TestPool(); t.after(() => pool.end()); await pool.query(stateSchema);
  const store = new HostedStore(pool, { ownerId: 'owner@example.com', projectId: ASSIGNMENT_PROJECT.id });
  await store.initialize(initialState(structuredClone(ASSIGNMENT_PROJECT), { model: 'anthropic/claude-opus-5', budgetMicros: 1000000 }));
  let clock = start; const now = () => clock;
  const calls = { judge: 0, sends: [] };
  let next = response;
  const judge = async input => {
    calls.judge++;
    await store.change(s => { s.requests[input.hostedRequestId].provider = { intentAt: now(), httpStatus: 200, sessionId: `synthetic-${calls.judge}`, reservedMicros: 1 }; s.reservedMicros += 1; });
    calls.lastInput = input; (calls.inputs ??= []).push(input);
    return structuredClone(next);
  };
  const coding = new HostedCoding(store, { now, read: draftRepositoryReader,
    config: { spec: { ...DRAFT_CODING_SPEC }, repeatable: true, verifiedUntil: '2026-10-19T12:00:00Z', token: 'synthetic-token-never-sent-0000' },
    send: async payload => { calls.sends.push(payload); return { outcome: 'accepted' }; } });
  const steward = new HostedSteward(store, judge, { now, coding });
  const r = await steward.reviewPilot({ budgetMicros: 1000000, maxProviderAttempts: 50 }); await steward.approvePilot({ reviewHash: r.reviewHash });
  const revision = (await store.read()).project.revision;
  return { store, steward, coding, calls, revision, advance: v => { clock = v; }, respond: v => { next = v; } };
}
const codingEvents = state => state.events.filter(e => /^coding_(dispatch|correction)/.test(e.kind));

test('one judge call yields a reviewable draft without reconfirming the settled priority or dispatching', async t => {
  const w = await world(t);
  const record = await w.steward.propose({ requestId: 'draft-one', projectId: ASSIGNMENT_PROJECT.id, message: SUFFICIENT_REQUEST, mode: 'assignment_draft', expectedContextRevision: w.revision });
  assert.equal(w.calls.judge, 1); assert.equal(w.calls.lastInput.mode, 'assignment_draft'); assert.equal(record.mode, 'assignment_draft');
  assert.equal(record.status, 'awaiting_approval'); assert.equal(record.proposal.kind, 'plan');
  assert.equal(Object.hasOwn(record.proposal, 'draft'), false);
  assert.equal(record.proposalHash, digest({ projectId: ASSIGNMENT_PROJECT.id, contextRevision: w.revision, proposal: core(DRAFT_OK) }));
  assert.equal(record.assignmentDraft.outcome, SUFFICIENT_REQUEST);
  assert.match(w.calls.lastInput.project.sources.find(s => s.id === 'brief').content, /settled by the owner/);
  const state = await w.store.read();
  assert.deepEqual(state.commitments, {}); assert.deepEqual(codingEvents(state), []); assert.equal(w.calls.sends.length, 0);
  const view = await w.steward.view();
  assert.equal(view.requests[0].assignmentDraft.draftHash, record.assignmentDraft.draftHash);
});

test('missing context produces one focused question and no draft', async t => {
  const w = await world(t, DRAFT_GAP);
  const record = await w.steward.propose({ requestId: 'gap-one', projectId: ASSIGNMENT_PROJECT.id, message: GAP_REQUEST, mode: 'assignment_draft', expectedContextRevision: w.revision });
  assert.equal(record.status, 'needs_context'); assert.equal(record.proposal.question, DRAFT_GAP.question);
  assert.equal(record.assignmentDraft, undefined); assert.equal(w.calls.sends.length, 0);
  await assert.rejects(w.coding.prepare({ requestId: 'from-gap', fromRequestId: 'gap-one', objective: GAP_REQUEST, acceptance: 'x', allowedPaths: ['src/slug.js'], expectedContextRevision: w.revision }), /APPROVAL_MISMATCH/);
});

test('a draft on a non-plan is ignored and a malformed draft is held like any invalid output', async t => {
  const w = await world(t, { kind: 'commitment', candidateId: null, title: 'Review slugs', rationale: 'r', citations: ['brief'], question: null, draft: DRAFT_OK.draft });
  const ignored = await w.steward.propose({ requestId: 'commit-one', projectId: ASSIGNMENT_PROJECT.id, message: 'next?', mode: 'assignment_draft', expectedContextRevision: w.revision });
  assert.equal(ignored.status, 'awaiting_approval'); assert.equal(ignored.draftIgnored, 'not_a_plan'); assert.equal(ignored.assignmentDraft, undefined);
  await w.steward.approve({ requestId: 'commit-one', proposalHash: ignored.proposalHash });
  w.respond({ ...DRAFT_OK, draft: { ...DRAFT_OK.draft, merge: true } });
  const held = await w.steward.propose({ requestId: 'bad-draft', projectId: ASSIGNMENT_PROJECT.id, message: SUFFICIENT_REQUEST, mode: 'assignment_draft', expectedContextRevision: w.revision });
  assert.equal(held.status, 'held');
});

async function drafted(t, start) {
  const w = await world(t, DRAFT_OK, start);
  const plan = await w.steward.propose({ requestId: 'draft-one', projectId: ASSIGNMENT_PROJECT.id, message: SUFFICIENT_REQUEST, mode: 'assignment_draft', expectedContextRevision: w.revision });
  return { w, plan, form: { ...plan.assignmentDraft.composed } };
}

test('edit after review supersedes the earlier approval; dispatch equals the exact approved edit, once', async t => {
  const { w, plan, form } = await drafted(t);
  const first = await w.coding.prepare({ requestId: 'assign-one', fromRequestId: 'draft-one', ...form, expectedContextRevision: w.revision });
  let state = await w.store.read();
  assert.deepEqual(state.requests['assign-one'].provenance, { unverifiedPaths: [], fromDraft: plan.assignmentDraft.draftHash, editedByOwner: false, outcomeIntact: true });
  assert.equal(state.requests['draft-one'].status, 'assignment_prepared');
  assert.equal(first.spec.objective, form.objective); assert.deepEqual(first.spec.allowedPaths, form.allowedPaths);
  assert.equal(w.calls.sends.length, 0); assert.deepEqual(codingEvents(state), []);
  const acceptance = `${form.acceptance}\n3. Confirm "Ünïcode  title" keeps its letters`;
  const edited = await w.coding.prepare({ requestId: 'assign-two', fromRequestId: 'draft-one', supersedes: 'assign-one', ...form, acceptance, expectedContextRevision: w.revision });
  state = await w.store.read();
  assert.equal(state.requests['assign-one'].status, 'superseded'); assert.equal(state.requests['assign-one'].supersededBy, 'assign-two');
  assert.equal(state.requests['assign-one'].codingReview, undefined);
  assert.equal(state.requests['assign-two'].provenance.editedByOwner, true); assert.equal(state.requests['assign-two'].provenance.outcomeIntact, true);
  assert.equal(w.calls.sends.length, 0); assert.equal(w.calls.judge, 1);
  await assert.rejects(w.coding.approveAndDispatch(first), /CODING_APPROVAL_MISMATCH/);
  await assert.rejects(w.coding.review({ requestId: 'assign-one', proposalHash: first.proposalHash }), /CODING_APPROVAL_MISMATCH/);
  assert.equal(w.calls.sends.length, 0);
  // Idempotent retry of the same edit, but no second replacement of the retired version.
  assert.equal((await w.coding.prepare({ requestId: 'assign-two', fromRequestId: 'draft-one', supersedes: 'assign-one', ...form, acceptance, expectedContextRevision: w.revision })).requestId, 'assign-two');
  await assert.rejects(w.coding.prepare({ requestId: 'assign-three', fromRequestId: 'draft-one', supersedes: 'assign-one', ...form, expectedContextRevision: w.revision }), /APPROVAL_MISMATCH/);
  await w.coding.approveAndDispatch(edited); await w.coding.approveAndDispatch(edited);
  assert.equal(w.calls.sends.length, 1);
  const sent = JSON.parse(w.calls.sends[0].text);
  assert.equal(sent.acceptance, acceptance); assert.equal(sent.objective, form.objective);
  assert.ok(sent.objective.startsWith(SUFFICIENT_REQUEST)); assert.deepEqual(sent.allowedPaths, form.allowedPaths);
  await assert.rejects(w.coding.prepare({ requestId: 'assign-four', fromRequestId: 'draft-one', supersedes: 'assign-two', ...form, expectedContextRevision: w.revision }), /APPROVAL_MISMATCH/);
});

test('supersede is limited to an undispatched assignment from the same plan', async t => {
  const { w, form } = await drafted(t);
  await assert.rejects(w.coding.prepare({ requestId: 'x-one', fromRequestId: 'draft-one', supersedes: 'missing', ...form, expectedContextRevision: w.revision }), /APPROVAL_MISMATCH/);
  await w.coding.prepare({ requestId: 'assign-one', fromRequestId: 'draft-one', ...form, expectedContextRevision: w.revision });
  await assert.rejects(w.coding.prepare({ requestId: 'x-two', fromRequestId: 'draft-one', ...form, expectedContextRevision: w.revision }), /APPROVAL_MISMATCH/);
  await assert.rejects(w.coding.prepare({ requestId: 'x-three', supersedes: 'assign-one', ...form, expectedContextRevision: w.revision }), /APPROVAL_MISMATCH/);
  await assert.rejects(w.coding.prepare({ requestId: 'assign-one-b', fromRequestId: 'draft-one', supersedes: 'assign-one-b', ...form, expectedContextRevision: w.revision }), /INVALID_REQUEST/);
});

test('stale context blocks preparing and approving a drafted assignment; nothing is sent', async t => {
  // Start ten minutes before the brief expires so the 15-minute review itself is still unexpired:
  // the rejection below is caused by the stale context alone.
  const { w, form } = await drafted(t, '2026-09-25T23:50:00.000Z');
  const review = await w.coding.prepare({ requestId: 'assign-one', fromRequestId: 'draft-one', ...form, expectedContextRevision: w.revision });
  w.advance('2026-09-26T00:00:01.000Z');
  assert.ok(Date.parse(review.expiresAt) > Date.parse('2026-09-26T00:00:01.000Z'));
  assert.equal((await w.steward.view()).contextFresh, false);
  await assert.rejects(w.coding.approveAndDispatch(review), /CODING_APPROVAL_MISMATCH/);
  await assert.rejects(w.coding.review({ requestId: 'assign-one', proposalHash: review.proposalHash }), /CODING_APPROVAL_MISMATCH/);
  await assert.rejects(w.coding.prepare({ requestId: 'assign-two', fromRequestId: 'draft-one', supersedes: 'assign-one', ...form, expectedContextRevision: w.revision }), /APPROVAL_MISMATCH/);
  assert.equal(w.calls.sends.length, 0); assert.deepEqual(codingEvents(await w.store.read()), []);
});

test('an owner-added path outside the approved context is flagged on the prepared assignment, not silently trusted', async t => {
  const { w, form } = await drafted(t);
  await w.coding.prepare({ requestId: 'assign-one', fromRequestId: 'draft-one', ...form, allowedPaths: [...form.allowedPaths, 'src/links/format.js'], expectedContextRevision: w.revision });
  const p = (await w.store.read()).requests['assign-one'].provenance;
  assert.deepEqual(p.unverifiedPaths, ['src/links/format.js']); assert.equal(p.editedByOwner, true); assert.equal(p.outcomeIntact, true);
  await w.coding.prepare({ requestId: 'assign-two', fromRequestId: 'draft-one', supersedes: 'assign-one', ...form, objective: 'Something else entirely', expectedContextRevision: w.revision });
  assert.equal((await w.store.read()).requests['assign-two'].provenance.outcomeIntact, false);
});

test('draft mode is opt-in: ordinary requests keep their schema and identity; unknown modes fail before network', async t => {
  const { createEveJudge } = await import('../judge.js');
  const { draftProposalSchema } = await import('../schema.js');
  const { createServer } = await import('node:http');
  const bodies = [];
  const server = createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { bodies.push(b); res.writeHead(500, { 'content-type': 'application/json' }); res.end('{}'); }); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const judge = await createEveJudge({ enabled: true, hosted: true, host: `http://127.0.0.1:${server.address().port}`, authToken: 'synthetic-local-fixture-token-123' });
  const base = { request: SUFFICIENT_REQUEST, project, commitments: [], hostedRequestId: 'draft-one' };
  await assert.rejects(judge({ ...base, mode: 'coding_review' }), /JUDGE_INPUT_INVALID/);
  await assert.rejects(judge({ ...base, mode: 'anything' }), /JUDGE_INPUT_INVALID/);
  assert.equal(bodies.length, 0);
  await assert.rejects(judge(base), /JUDGE_UNAVAILABLE_OR_INVALID/);
  await assert.rejects(judge({ ...base, mode: 'assignment_draft' }), /JUDGE_UNAVAILABLE_OR_INVALID/);
  assert.equal(bodies.length, 2);
  assert.ok(!bodies[0].includes('acceptanceExamples') && !bodies[0].includes('assignment_draft'));
  assert.ok(bodies[1].includes('acceptanceExamples') && bodies[1].includes('assignment_draft'));
  // The hosted transport admits a call only when the message digest equals the steward's record.
  assert.ok(bodies[1].includes(JSON.stringify(JSON.stringify({ ...base, mode: 'assignment_draft' })).slice(1, -1)));
  assert.equal(draftProposalSchema.safeParse({ ...DRAFT_GAP }).success, true);
  assert.equal(draftProposalSchema.safeParse(core(DRAFT_OK)).success, false, 'draft key is required (nullable) in draft mode');
  assert.equal(proposalSchema.safeParse(DRAFT_OK).success, false, 'ordinary schema is unchanged and rejects a draft');
  const w = await world(t);
  const plain = await w.steward.propose({ requestId: 'plain-one', projectId: ASSIGNMENT_PROJECT.id, message: SUFFICIENT_REQUEST, expectedContextRevision: w.revision });
  assert.equal(plain.draftIgnored, 'not_requested'); assert.equal(plain.assignmentDraft, undefined); assert.equal(plain.mode, undefined);
  assert.equal(plain.inputHash, digest({ projectId: ASSIGNMENT_PROJECT.id, message: SUFFICIENT_REQUEST }));
  assert.equal(Object.hasOwn(w.calls.inputs.at(-1), 'mode'), false);
  await assert.rejects(w.steward.propose({ requestId: 'plain-one', projectId: ASSIGNMENT_PROJECT.id, message: SUFFICIENT_REQUEST, mode: 'assignment_draft', expectedContextRevision: w.revision }), /REQUEST_ID_CONFLICT/);
  await assert.rejects(w.steward.propose({ requestId: 'odd-mode', projectId: ASSIGNMENT_PROJECT.id, message: SUFFICIENT_REQUEST, mode: 'coding_review', expectedContextRevision: w.revision }), /INVALID_REQUEST/);
});
