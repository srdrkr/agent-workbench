import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TestPool } from './pg-fixture.js';
import { HostedStore, stateSchema } from '../hosted/store.js';
import { HostedSteward, initialState, digest } from '../hosted/steward.js';
import { hostedTransport, HOSTED_MODEL } from '../hosted/transport.js';
import { FollowThrough } from '../hosted/follow-through.js';
import { ownerAuth } from '../hosted/auth.js';
import { hostedHandler } from '../hosted/http.js';
import { setupHosted } from '../hosted/setup.js';
import { seedSyntheticTask, runSyntheticReview } from './held-review-fixture.js';

const project = JSON.parse(await readFile(new URL('../../../fixtures/steward-project.json', import.meta.url)));
const ownerEmail = 'owner@example.com'; const origin = 'http://localhost:4399';
const proposal = { kind: 'commitment', candidateId: null, title: 'Review the blocker', rationale: 'The brief needs an owner decision.', citations: ['brief'], question: null };

async function fixture(t, { attempts = 50, pool: given } = {}) {
  let clock = Date.parse('2026-09-24T12:00:00.000Z');
  const now = () => new Date(clock).toISOString();
  const pool = given ?? new TestPool(); if (!given) { t.after(() => pool.end()); await pool.query(stateSchema); }
  const store = new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id });
  if (!given) await store.initialize(initialState(project, { model: HOSTED_MODEL, budgetMicros: 1_000_000 }));
  const counters = { judge: 0, send: 0, proposeJudge: 0 };
  // Every model path is counted. A proposal gets a synthetic verified receipt.
  const steward = new HostedSteward(store, async input => {
    counters.proposeJudge++;
    await store.change(state => { state.requests[input.hostedRequestId].provider = { intentAt: now(), httpStatus: 200, sessionId: 'synthetic-propose', reservedMicros: 1 }; state.reservedMicros += 1; });
    return proposal;
  }, { now });
  const review = await steward.reviewPilot({ budgetMicros: 1_000_000, maxProviderAttempts: attempts });
  await steward.approvePilot({ reviewHash: review.reviewHash });
  await seedSyntheticTask(store, now);
  return { pool, store, steward, counters, now, advance: ms => { clock += ms; } };
}
const held = async (f, outcome) => {
  const { reviewId } = await runSyntheticReview({ store: f.store, now: f.now, outcome, counters: f.counters });
  const view = await f.steward.view();
  return { reviewId, record: view.requests.find(r => r.id === reviewId), view };
};
const sent = f => f.counters.judge + f.counters.send + f.counters.proposeJudge;
const ask = id => ({ requestId: id, projectId: project.id, message: 'What should I do next?' });

test('confirmed refusal: handoff, persisted acknowledgement, retained records, no model call, then a fresh request', async t => {
  const f = await fixture(t);
  const { reviewId, record } = await held(f, 'refused');
  assert.equal(record.status, 'held'); assert.equal(record.purpose, 'coding_review');
  assert.equal(record.retryReviewHash, null, 'a coding review is never offered the proposal retry');
  const r = record.recovery;
  assert.equal(r.case, 'confirmed_rejection'); assert.equal(r.action, 'acknowledge'); assert.match(r.acknowledgeHash, /^[a-f0-9]{64}$/);
  assert.equal(r.evidence.httpStatus, 400); assert.equal(r.evidence.errorCategory, 'invalid_request_error');
  assert.match(r.whatHappened, /refused/); assert.match(r.unknown, /reservation/); assert.equal(r.whoActs, 'You (the owner)');
  assert.match(r.nextStep, /fresh request/); assert.equal(r.taskStatus, 'blocked');
  await assert.rejects(f.steward.propose(ask('blocked-while-held')), /UNRESOLVED_MODEL_ATTEMPT/);

  const before = await f.store.read(); const calls = sent(f);
  const done = await f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: r.acknowledgeHash });
  assert.equal(sent(f), calls, 'acknowledging sends no model or Routine request');
  assert.equal(done.status, 'rejection_acknowledged'); assert.equal(done.resolution.case, 'confirmed_rejection');
  const after = await f.store.read();
  assert.deepEqual(after.requests[reviewId].provider, before.requests[reviewId].provider);
  assert.equal(after.requests[reviewId].completedAt, before.requests[reviewId].completedAt);
  assert.equal(after.reservedMicros, before.reservedMicros); assert.equal(after.budgetMicros, before.budgetMicros);
  assert.deepEqual(after.coding, before.coding, 'terminal task history and grant are untouched');
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(after.events.length, before.events.length + 1); assert.equal(after.events.at(-1).kind, 'held_rejection_acknowledged');
  assert.equal(after.events.at(-1).data.retainedReservationMicros, before.requests[reviewId].provider.reservedMicros);

  // Persisted: a new store and steward on the same database see the same result.
  const reopened = new HostedSteward(new HostedStore(f.pool, { ownerId: ownerEmail, projectId: project.id }), async () => assert.fail('no model call'), { now: f.now });
  const view = await reopened.view(); const shown = view.requests.find(x => x.id === reviewId);
  assert.equal(shown.status, 'rejection_acknowledged'); assert.equal(shown.recovery, null);
  // Idempotent: repeating returns the same record and adds no second action.
  const again = await f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: r.acknowledgeHash });
  assert.deepEqual(again, done); assert.equal((await f.store.read()).events.length, after.events.length); assert.equal(sent(f), calls);
  // The old follow-through is not resumed.
  await new FollowThrough({ store: f.store, now: f.now, coding: { reconcile: () => assert.fail('no reconcile') }, review: () => assert.fail('no review') }).run();
  assert.equal((await f.store.read()).coding.jobs['synthetic-task'].followThrough.status, 'blocked');
  // The old ID cannot become a new proposal; a fresh ID goes through normal proposal and approval.
  await assert.rejects(f.steward.propose({ ...ask(reviewId) }), /REQUEST_ID_CONFLICT/);
  const next = await f.steward.propose(ask('fresh-request-1'));
  assert.equal(next.status, 'awaiting_approval'); assert.equal(f.counters.proposeJudge, 1);
  assert.equal((await f.steward.approve({ requestId: next.id, proposalHash: next.proposalHash })).status, 'approved');
});

test('stale, mismatched and unsupported acknowledgements are rejected without changes', async t => {
  const f = await fixture(t);
  const { reviewId, record } = await held(f, 'refused');
  const snapshot = JSON.stringify(await f.store.read());
  const wrong = 'f'.repeat(64);
  await assert.rejects(f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: wrong }), /RECOVERY_REVIEW_STALE/);
  await assert.rejects(f.steward.acknowledgeRejectedReview({ requestId: 'missing', acknowledgeHash: record.recovery.acknowledgeHash }), /RECOVERY_REVIEW_STALE/);
  await assert.rejects(f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: 'short' }), /INVALID_REQUEST/);
  await assert.rejects(f.steward.acknowledgeRejectedReview({ requestId: '__proto__', acknowledgeHash: wrong }), /RECOVERY_REVIEW_STALE/);
  assert.equal(JSON.stringify(await f.store.read()), snapshot);
  // A hash issued before the evidence changed (grant now expired) is stale.
  f.advance(25 * 3600000);
  await assert.rejects(f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: record.recovery.acknowledgeHash }), /RECOVERY_REVIEW_STALE/);
  const current = (await f.steward.view()).requests.find(x => x.id === reviewId).recovery;
  assert.equal(current.case, 'expired_authority'); assert.notEqual(current.acknowledgeHash, record.recovery.acknowledgeHash);
});

test('acknowledgement waits until follow-through has stopped the task', async t => {
  const f = await fixture(t);
  const { reviewId } = await held(f, 'refused');
  // Synthetic crash window: the review was recorded but follow-through had not stopped the task yet.
  await f.store.change(s => { const x = s.coding.jobs['synthetic-task'].followThrough; x.status = 'reviewing'; x.reason = null; x.nextCheckAt = null; });
  const waiting = (await f.steward.view()).requests.find(x => x.id === reviewId).recovery;
  assert.equal(waiting.action, 'none'); assert.equal(waiting.acknowledgeHash, null); assert.match(waiting.missing, /not stopped/);
  await assert.rejects(f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: 'e'.repeat(64) }), /RECOVERY_TASK_ACTIVE/);
  await new FollowThrough({ store: f.store, now: f.now, coding: { reconcile: () => assert.fail('no reconcile') }, review: () => assert.fail('no review') }).run();
  const ready = (await f.steward.view()).requests.find(x => x.id === reviewId).recovery;
  assert.equal(ready.action, 'acknowledge'); assert.equal(ready.taskStatus, 'blocked');
  assert.equal((await f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: ready.acknowledgeHash })).status, 'rejection_acknowledged');
});

test('a refused review whose task record is missing stays held for the operator', async t => {
  const f = await fixture(t);
  const { reviewId } = await held(f, 'refused');
  // Synthetic damaged state: the task record is gone.
  await f.store.change(s => { delete s.coding.jobs['synthetic-task']; });
  const r = (await f.steward.view()).requests.find(x => x.id === reviewId).recovery;
  assert.equal(r.action, 'none'); assert.equal(r.whoActs, 'Operator'); assert.match(r.missing, /task record/);
  await assert.rejects(f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: 'b'.repeat(64) }), /RECOVERY_NOT_SUPPORTED/);
});

for (const [outcome, kind, missing] of [
  ['lost', 'uncertain_delivery', /session reconciliation/],
  ['unverified', 'unverified_output', /neither is stored/],
  ['status_only', 'unclassified', /error category/],
  ['server_error', 'unclassified', /refused the request before executing/],
]) {
  test(`${outcome} review outcome stays held as ${kind} with a named missing piece`, async t => {
    const f = await fixture(t);
    const { reviewId, record } = await held(f, outcome);
    assert.equal(record.status, 'held'); assert.equal(record.recovery.case, kind);
    assert.equal(record.recovery.action, 'none'); assert.equal(record.recovery.acknowledgeHash, null);
    assert.match(record.recovery.missing, missing); assert.match(record.recovery.nextStep, /Keep this held/);
    assert.match(record.recovery.whoActs, /Operator/);
    const calls = sent(f); const snapshot = JSON.stringify(await f.store.read());
    await assert.rejects(f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: 'd'.repeat(64) }), /RECOVERY_NOT_SUPPORTED/);
    await assert.rejects(f.steward.propose(ask('fresh-while-uncertain')), /UNRESOLVED_MODEL_ATTEMPT/);
    assert.equal(JSON.stringify(await f.store.read()), snapshot); assert.equal(sent(f), calls);
  });
}

test('expired authority is distinct; acknowledgement does not resume the grant', async t => {
  const f = await fixture(t);
  const { reviewId } = await held(f, 'rate_limited');
  f.advance(25 * 3600000);
  const r = (await f.steward.view()).requests.find(x => x.id === reviewId).recovery;
  assert.equal(r.case, 'expired_authority'); assert.equal(r.action, 'acknowledge'); assert.match(r.nextStep, /grant expired.*not resumed/s);
  const grant = structuredClone((await f.store.read()).coding.jobs['synthetic-task'].followThrough.grant);
  await f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: r.acknowledgeHash });
  const stored = await f.store.read(); const task = stored.coding.jobs['synthetic-task'];
  assert.equal(stored.requests[reviewId].status, 'rejection_acknowledged'); assert.equal(stored.requests[reviewId].resolution.case, 'expired_authority');
  assert.deepEqual(task.followThrough.grant, grant); assert.equal(task.followThrough.status, 'blocked');
});

test('provider spend limit and local allowance exhaustion are shown as allowance exhaustion, never refilled', async t => {
  const f = await fixture(t);
  const { reviewId } = await held(f, 'spend_limit');
  const r = (await f.steward.view()).requests.find(x => x.id === reviewId).recovery;
  assert.equal(r.case, 'allowance_exhausted'); assert.match(r.nextStep, /spend limit.*outside Steward/s);
  const before = await f.store.read();
  await f.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: r.acknowledgeHash });
  const after = await f.store.read();
  assert.equal(after.budgetMicros, before.budgetMicros); assert.equal(after.reservedMicros, before.reservedMicros);

  const local = await fixture(t, { attempts: 1 });
  const second = await held(local, 'rate_limited');
  assert.equal(second.record.recovery.case, 'allowance_exhausted'); assert.match(second.record.recovery.nextStep, /pilot allowance/);
  const pilot = await local.steward.reviewPilot({ budgetMicros: 1_000_000, maxProviderAttempts: 5 });
  await assert.rejects(local.steward.approvePilot({ reviewHash: pilot.reviewHash }), /CONTEXT_WORK_UNRESOLVED/);
  await local.steward.acknowledgeRejectedReview({ requestId: second.reviewId, acknowledgeHash: second.record.recovery.acknowledgeHash });
  await assert.rejects(local.steward.propose(ask('over-limit')), /ADMISSION_PAUSED/);
  const renewed = await local.steward.reviewPilot({ budgetMicros: 1_000_000, maxProviderAttempts: 5 });
  await local.steward.approvePilot({ reviewHash: renewed.reviewHash });
  assert.equal((await local.steward.propose(ask('after-new-allowance'))).status, 'awaiting_approval');
});

test('a refused proposal keeps the existing one-time retry and has no acknowledgement', async t => {
  const pool = new TestPool(); t.after(() => pool.end()); await pool.query(stateSchema);
  const now = () => '2026-09-24T12:00:00.000Z';
  const store = new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id });
  await store.initialize(initialState(project, { model: HOSTED_MODEL, budgetMicros: 1_000_000 }));
  const steward = new HostedSteward(store, async input => {
    await hostedTransport({ store, requestId: input.hostedRequestId, inputDigest: digest(input), sessionId: 'synthetic', now,
      send: async () => new Response(JSON.stringify({ error: { type: 'rate_limit_exceeded' } }), { status: 429 }) })('https://ai-gateway.vercel.sh/v4/ai/language-model',
      { method: 'POST', headers: { 'ai-language-model-id': HOSTED_MODEL }, body: JSON.stringify({ maxOutputTokens: 2048, prompt: [{ role: 'user', content: 'Synthetic' }], tools: [{ type: 'function', name: 'final_output', inputSchema: { type: 'object' } }] }) });
  }, { now });
  assert.equal((await steward.propose(ask('refused-proposal'))).status, 'held');
  const record = (await steward.view()).requests[0];
  assert.match(record.retryReviewHash, /^[a-f0-9]{64}$/);
  assert.equal(record.recovery.case, 'confirmed_rejection'); assert.equal(record.recovery.action, 'none'); assert.match(record.recovery.nextStep, /Retry this request once/);
  await assert.rejects(steward.acknowledgeRejectedReview({ requestId: record.id, acknowledgeHash: 'c'.repeat(64) }), /RECOVERY_NOT_SUPPORTED/);
});

test('the acknowledge route is owner-authenticated, origin-checked and idempotent over HTTP', async t => {
  const pool = new TestPool(); t.after(() => pool.end());
  const secret = 'local-test-secret-at-least-thirty-two-characters'; const password = 'synthetic-local-test-password';
  await setupHosted(pool, { origin, secret, ownerEmail, password, project, budgetMicros: 1_000_000 });
  const f = await fixture(t, { pool });
  const { reviewId, record } = await held(f, 'refused');
  const handle = hostedHandler({ auth: ownerAuth(pool, { origin, secret }), steward: f.steward, ownerEmail, origin });
  const req = (path, body, cookie, from = origin) => new Request(origin + path, { method: 'POST', headers: { origin: from, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), 'x-forwarded-for': '127.0.0.1' }, body: JSON.stringify(body) });
  const body = { requestId: reviewId, acknowledgeHash: record.recovery.acknowledgeHash };
  assert.equal((await handle(req('/api/steward/recovery/acknowledge', body))).status, 401);
  const login = await handle(req('/api/auth/sign-in/email', { email: ownerEmail, password }));
  const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  assert.equal((await handle(req('/api/steward/recovery/acknowledge', body, cookie, 'https://evil.example'))).status, 403);
  assert.equal((await f.store.read()).requests[reviewId].status, 'held');
  const stale = await handle(req('/api/steward/recovery/acknowledge', { ...body, acknowledgeHash: 'f'.repeat(64) }, cookie));
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error, 'RECOVERY_REVIEW_STALE');
  const calls = sent(f);
  const first = await handle(req('/api/steward/recovery/acknowledge', body, cookie)); assert.equal(first.status, 200);
  const second = await handle(req('/api/steward/recovery/acknowledge', body, cookie)); assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), await first.json()); assert.equal(sent(f), calls);
  assert.equal((await f.store.read()).events.filter(e => e.kind === 'held_rejection_acknowledged').length, 1);
});
