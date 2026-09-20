import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TestPool } from './pg-fixture.js';
import { HostedStore, stateSchema } from '../hosted/store.js';
import { HostedSteward, initialState, digest } from '../hosted/steward.js';
import { continuationPacket, judgmentProject, attemptLimit } from '../hosted/continuation.js';
import { hostedTransport, HOSTED_MODEL } from '../hosted/transport.js';
const project = JSON.parse(await readFile(new URL('../../../fixtures/steward-project.json', import.meta.url)));
const at = '2026-09-19T12:00:00.000Z';
const proposal = { kind: 'commitment', candidateId: null, title: 'Review the completed draft', rationale: 'The verified draft needs owner review, not another coding run.', citations: ['coding-result'], question: null };
function seed() {
  const s = initialState(structuredClone(project), { model: HOSTED_MODEL, budgetMicros: 1_000_000 });
  const base = { projectId: project.id, contextRevision: s.project.revision, judge: s.model, inputHash: 'same', completedAt: at };
  for (let i = 0; i < 3; i++) s.requests[`old-${i}`] = { ...base, id: `old-${i}`, status: 'needs_context', provider: { httpStatus: 200, reservedMicros: 100000 } };
  s.requests.failed = { ...base, id: 'failed', status: 'held', retryRequestId: 'recovered', provider: { intentAt: at, sessionId: 'synthetic-failure', reservedMicros: 100000, httpStatus: 429, rejection: { httpStatus: 429, errorCategory: 'rate_limit_exceeded' } } };
  s.requests.recovered = { ...base, id: 'recovered', status: 'coding_dispatched', retryOf: 'failed', proposalHash: 'synthetic-proposal', provider: { httpStatus: 200, reservedMicros: 100000 } };
  s.reservedMicros = 500000;
  const spec = s.project.codingCandidates[0].spec;
  s.coding = { active: null, paused: false, jobs: { recovered: { id: 'recovered', spec,
    contextRevision: s.project.revision, dispatch: 'unknown', execution: 'exited', releasedAt: at,
    executionObservation: { state: 'exited', source: 'owner_provider_ui', markerVerified: true, recordedEvent: 1, observedAt: at },
    result: { source: 'github_api', result: 'tested_draft_pr', stable: true, approvedBase: true, scopeMatches: true,
      collectionStartedEvent: 2, observedAt: at, headSha: '2'.repeat(40), prNumber: 2,
      prUrl: `https://github.com/${spec.repository}/pull/2`, requiredChecks: spec.requiredChecks.map(c => ({ ...c, status: 'completed', conclusion: 'success' })),
      workerReport: { secret: 'NEVER_INCLUDE_PRIVATE_WORKER_TEXT' } } } } };
  return s;
}
async function fixture(t, state = seed(), judge) {
  const pool = new TestPool(); t.after(() => pool.end()); await pool.query(stateSchema);
  const store = new HostedStore(pool, { ownerId: 'owner@example.com', projectId: project.id }); await store.initialize(state);
  const steward = new HostedSteward(store, judge ?? (() => { throw Error('No model call allowed'); }), { now: () => at });
  return { store, steward };
}

test('continuation approval preserves all accounting/evidence, discloses only the reviewed source and is idempotent', async t => {
  const { store, steward } = await fixture(t); const before = await store.read();
  assert.equal((await steward.view()).continuationAvailable, true);
  const review = await steward.reviewContinuation();
  assert.equal((await store.read()).maxProviderAttempts, undefined);
  assert.equal(review.nextLimit, 6); assert.equal(review.budgetMicros, 1000000);
  assert.ok(!JSON.stringify(review).includes('NEVER_INCLUDE_PRIVATE_WORKER_TEXT'));
  const receipts = await Promise.all([steward.approveContinuation({ reviewHash: review.reviewHash }), steward.approveContinuation({ reviewHash: review.reviewHash })]);
  assert.deepEqual(receipts[0], receipts[1]);
  const s = await store.read(); assert.equal(attemptLimit(s), 6); assert.equal(s.reservedMicros, before.reservedMicros);
  assert.equal(s.budgetMicros, before.budgetMicros); assert.equal(s.model, before.model);
  assert.deepEqual(s.coding, before.coding); assert.deepEqual(s.requests.failed.provider, before.requests.failed.provider);
  assert.equal(s.requests.failed.status, 'resolved_rejection'); assert.equal(s.requests.failed.retryRequestId, 'recovered');
  assert.equal(s.events.filter(e => e.kind === 'continuation_approved').length, 1);
  assert.equal((await steward.view()).continuationAvailable, false);
  await assert.rejects(steward.reviewContinuation(), /UNAVAILABLE/);
  await assert.rejects(steward.approveContinuation({ reviewHash: 'other' }), /STALE/);
  const p = judgmentProject(s, at); assert.equal(p.codingCandidates.length, 0);
  assert.equal(p.sources.at(-1).id, 'coding-result'); assert.deepEqual(p.sources.at(-1), review.source);
  assert.deepEqual(s.project, before.project);
});

test('uncertain work, mismatched recovery, spend caps and stale/invalid result evidence never qualify', () => {
  const mutations = [
    s => { s.requests.failed.provider.httpStatus = 200; },
    s => { delete s.requests.failed.completedAt; },
    s => { s.requests.failed.provider.rejection.providerErrorCode = 'enforced_spend_limit_reached'; },
    s => { s.requests.recovered.retryOf = 'other'; },
    s => { s.requests.recovered.contextRevision = 'other'; },
    s => { s.requests.recovered.inputHash = 'other'; },
    s => { s.requests.recovered.provider.httpStatus = 429; },
    s => { s.requests.recovered.status = 'held'; },
    s => { s.requests['old-0'].status = 'thinking'; },
    s => { s.requests['old-0'].status = 'held'; },
    s => { s.coding.active = 'recovered'; },
    s => { s.coding.jobs.recovered.execution = 'running'; },
    s => { s.coding.jobs.recovered.releasedAt = null; },
    s => { s.coding.jobs.recovered.result.result = 'needs_review'; },
    s => { s.coding.jobs.recovered.result.requiredChecks[0].conclusion = 'failure'; },
    s => { s.coding.jobs.recovered.result.collectionStartedEvent = 1; },
    s => { s.coding.jobs.recovered.result.observedAt = '2026-09-17T12:00:00Z'; },
    s => { s.coding.jobs.recovered.spec.visibility = 'private'; },
    s => { s.paused = true; }, s => { s.coding.paused = true; },
    s => { s.reservedMicros = s.budgetMicros; }, s => { s.maxProviderAttempts = 6; },
    s => { s.telegram = { updates: { x: { status: 'accepted' } } }; },
    s => { s.project.sources[0].expiresAt = '2026-09-18T12:00:00Z'; },
  ];
  for (const mutate of mutations) { const s = seed(); mutate(s); assert.throws(() => continuationPacket(s, at), /UNAVAILABLE/); }
});

test('expired and superseded reviews, evidence refresh and accounting changes require a fresh review', async t => {
  for (const mutate of [s => { s.continuationReview.expiresAt = at; }, s => { s.reservedMicros++; },
    s => { s.coding.jobs.recovered.result.observedAt = '2026-09-19T11:59:59Z'; },
    s => { s.requests['old-0'].completedAt = '2026-09-19T11:59:59Z'; }]) {
    const { store, steward } = await fixture(t); const review = await steward.reviewContinuation(); await store.change(mutate);
    await assert.rejects(steward.approveContinuation({ reviewHash: review.reviewHash }), /STALE/);
    assert.equal(attemptLimit(await store.read()), 5);
  }
});

test('sixth request uses approved result snapshot and normal provider reservation; seventh request and transport replay fail', async t => {
  let store, seen, sends = 0;
  const f = await fixture(t, seed(), async input => {
    seen = input;
    const transport = hostedTransport({ store, requestId: input.hostedRequestId, inputDigest: digest(input), sessionId: 'synthetic-sixth', now: () => at,
      send: async () => { sends++; return new Response('{}'); } });
    const body = { method: 'POST', headers: { 'ai-language-model-id': HOSTED_MODEL }, body: JSON.stringify({ maxOutputTokens: 2048,
      prompt: [{ role: 'user', content: JSON.stringify(input) }], tools: [{ type: 'function', name: 'final_output', inputSchema: { type: 'object' } }] }) };
    await transport('https://ai-gateway.vercel.sh/v4/ai/language-model', body);
    await assert.rejects(transport('https://ai-gateway.vercel.sh/v4/ai/language-model', body), /ADMISSION_DENIED/);
    return proposal;
  }); store = f.store;
  const ask = { requestId: 'next', projectId: project.id, message: 'What owner decision follows the verified draft?' };
  await assert.rejects(f.steward.propose(ask), /ADMISSION_PAUSED/);
  const review = await f.steward.reviewContinuation(); await f.steward.approveContinuation({ reviewHash: review.reviewHash });
  assert.equal((await f.steward.propose(ask)).status, 'awaiting_approval'); assert.equal(sends, 1);
  assert.equal(seen.project.sources.at(-1).id, 'coding-result'); assert.equal(seen.project.codingCandidates.length, 0);
  assert.ok((await store.read()).reservedMicros > 500000);
  await assert.rejects(f.steward.propose({ ...ask, requestId: 'seventh' }), /ADMISSION_PAUSED/);
  assert.equal((await f.steward.propose(ask)).status, 'awaiting_approval'); assert.equal(sends, 1);
});

test('a consumed coding candidate cannot be re-proposed and expired completion snapshots fail before model I/O', async t => {
  const { store, steward } = await fixture(t);
  const review = await steward.reviewContinuation(); await steward.approveContinuation({ reviewHash: review.reviewHash });
  await store.change(s => { s.continuation.source.expiresAt = at; });
  await assert.rejects(steward.propose({ requestId: 'next', projectId: project.id, message: 'Next?' }), /SOURCE_EXPIRED/);
  assert.equal(Object.keys((await store.read()).requests).length, 5);
  const s = await store.read(); s.project.revision = 'other-project';
  assert.throws(() => judgmentProject(s, at), /CONTEXT_CHANGED/);
});


test('changing the brief after extension approval cannot spend the reviewed sixth request', async t => {
  const { store, steward } = await fixture(t);
  const review = await steward.reviewContinuation(); await steward.approveContinuation({ reviewHash: review.reviewHash });
  await store.change(s => { s.project.revision = 'changed'; });
  await assert.rejects(steward.propose({ requestId: 'next', projectId: project.id, message: 'Next?' }), /CONTEXT_CHANGED/);
  assert.equal((await steward.view()).continuationProblem, 'CONTINUATION_CONTEXT_CHANGED');
  assert.equal(Object.keys((await store.read()).requests).length, 5);
});

test('completion source expiry is enforced at provider admission and commitment approval', async t => {
  let store, sends = 0;
  const later = '2026-09-20T12:00:00.000Z';
  const f = await fixture(t, seed(), async input => {
    const transport = hostedTransport({ store, requestId: input.hostedRequestId, inputDigest: digest(input), sessionId: 'synthetic-expired', now: () => later,
      send: async () => { sends++; return new Response('{}'); } });
    await transport('https://ai-gateway.vercel.sh/v4/ai/language-model', { method: 'POST', headers: { 'ai-language-model-id': HOSTED_MODEL }, body: JSON.stringify({ maxOutputTokens: 2048,
      prompt: [{ role: 'user', content: 'synthetic' }], tools: [{ type: 'function', name: 'final_output', inputSchema: { type: 'object' } }] }) });
    return proposal;
  }); store = f.store;
  const review = await f.steward.reviewContinuation(); await f.steward.approveContinuation({ reviewHash: review.reviewHash });
  const ask = { requestId: 'next', projectId: project.id, message: 'Next?' };
  assert.equal((await f.steward.propose(ask)).status, 'not_sent'); assert.equal(sends, 0);
  assert.equal((await store.read()).reservedMicros, 500000);
  // Independently check a previously valid commitment after its snapshot expires.
  await store.change(s => { const r = s.requests.next; r.status = 'awaiting_approval'; r.proposal = proposal; r.proposalHash = 'synthetic-approval'; });
  const laterSteward = new HostedSteward(store, () => {}, { now: () => later });
  await assert.rejects(laterSteward.approve({ requestId: 'next', proposalHash: 'synthetic-approval' }), /APPROVAL_MISMATCH/);
});
