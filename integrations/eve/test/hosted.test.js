import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestPool } from './pg-fixture.js';
import { HostedStore, stateSchema } from '../hosted/store.js';
import { HostedSteward, initialState, digest } from '../hosted/steward.js';
import { hostedTransport, HOSTED_MODEL } from '../hosted/transport.js';
import { ownerAuth } from '../hosted/auth.js';
import { hostedHandler } from '../hosted/http.js';
import { setupHosted } from '../hosted/setup.js';
const project = JSON.parse(await readFile(new URL('../../../fixtures/steward-project.json', import.meta.url)));
const ownerEmail = 'owner@example.com'; const origin = 'http://localhost:4399';
const secret = 'local-test-secret-at-least-thirty-two-characters';
const password = 'synthetic-local-test-password';
const now = () => '2026-09-19T12:00:00.000Z';
const proposal = { kind: 'commitment', candidateId: null, title: 'Review the blocker', rationale: 'The brief needs an owner decision.', citations: ['brief'], question: null };
async function fixture(t, judge = async () => proposal, budgetMicros = 1_000_000, providerReceipt = true) {
  const pool = new TestPool(); t.after(() => pool.end());
  await pool.query(stateSchema);
  const store = new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id });
  await store.initialize(initialState(project, { model: HOSTED_MODEL, budgetMicros }));
  return { pool, store, steward: new HostedSteward(store, async input => {
    if (providerReceipt) await store.change(state => { state.requests[input.hostedRequestId].provider = { intentAt: now(), httpStatus: 200, sessionId: 'synthetic-session', reservedMicros: 1 }; state.reservedMicros += 1; });
    return judge(input);
  }, { now }) };
}
const ask = { requestId: 'request-one', projectId: project.id, message: 'What should I commit to?' };
function wire() { return { method: 'POST', headers: { 'ai-language-model-id': HOSTED_MODEL }, body: JSON.stringify({ maxOutputTokens: 2048, prompt: [{ role: 'user', content: 'Synthetic' }], tools: [{ type: 'function', name: 'final_output', inputSchema: { type: 'object' } }] }) }; }
const endpoint = 'https://ai-gateway.vercel.sh/v4/ai/language-model';

test('hosted state persists approvals across database close/reopen and scopes reads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hosted-pg-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let pool = new TestPool(dir); await pool.query(stateSchema);
  let store = new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id });
  await store.initialize(initialState(project, { model: HOSTED_MODEL, budgetMicros: 1_000_000 }));
  let steward = new HostedSteward(store, async input => { await store.change(state => { state.requests[input.hostedRequestId].provider = { intentAt: now(), httpStatus: 200, sessionId: 'synthetic-session', reservedMicros: 1 }; state.reservedMicros += 1; }); return proposal; }, { now });
  const record = await steward.propose(ask);
  await assert.rejects(steward.approve({ requestId: ask.requestId, proposalHash: 'wrong' }), /MISMATCH/);
  await steward.approve({ requestId: ask.requestId, proposalHash: record.proposalHash });
  await pool.end(); pool = new TestPool(dir); t.after(() => pool.end());
  store = new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id });
  steward = new HostedSteward(store, async () => { throw new Error('must not repeat'); }, { now });
  assert.equal((await steward.view()).commitments.length, 1);
  assert.equal((await steward.propose(ask)).status, 'approved');
  await assert.rejects(new HostedStore(pool, { ownerId: 'other@example.com', projectId: project.id }).read(), /NOT_CONFIGURED/);
});

test('two hosted instances serialize intent, reject competing work, and never replay unknown results', async t => {
  let finish; let calls = 0;
  const { store, steward } = await fixture(t, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = steward.propose(ask);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  const other = new HostedSteward(store, () => { calls++; }, { now });
  assert.equal((await other.propose(ask)).status, 'thinking');
  await assert.rejects(other.propose({ ...ask, requestId: 'other' }), /UNRESOLVED/);
  finish(undefined); assert.equal((await pending).status, 'held');
  assert.equal((await other.propose(ask)).status, 'held'); assert.equal(calls, 1);
  await assert.rejects(other.propose({ ...ask, message: 'Changed' }), /CONFLICT/);
});

test('hosted proposal validates freshness, citation, coding scope and prototype-like IDs', async t => {
  const { store, steward } = await fixture(t);
  const record = await steward.propose({ ...ask, requestId: 'constructor' });
  assert.equal(record.status, 'awaiting_approval');
  await store.change(state => { state.project.sources[0].expiresAt = '2026-09-18T00:00:00Z'; });
  await assert.rejects(steward.approve({ requestId: record.id, proposalHash: record.proposalHash }), /MISMATCH/);
  await assert.rejects(steward.propose({ ...ask, requestId: 'expired' }), /EXPIRED/);
  const bad = await fixture(t, async () => ({ ...proposal, citations: ['invented'] }));
  assert.equal((await bad.steward.propose(ask)).status, 'held');
  const coding = await fixture(t, async () => ({ ...proposal, kind: 'coding', candidateId: 'normalize', citations: ['brief', 'acceptance'] }));
  const candidate = await coding.steward.propose(ask);
  await assert.rejects(coding.steward.approve({ requestId: candidate.id, proposalHash: candidate.proposalHash }), /CODING_NOT_ENABLED/);
});

test('provider intent is durable before I/O; replay and 429 never send again', async t => {
  let store; let sends = 0;
  const f = await fixture(t, async input => {
    const transport = hostedTransport({ store, requestId: input.hostedRequestId, inputDigest: digest(input), sessionId: 'synthetic-session', send: async () => {
      sends++; assert.ok((await store.read()).requests[ask.requestId].provider.intentAt);
      return new Response('{"error":{"message":"private provider error"}}', { status: 429 });
    } });
    await assert.rejects(transport(endpoint, wire()), /UNKNOWN/);
    await assert.rejects(transport(endpoint, wire()), /ADMISSION_DENIED/);
    throw new Error('unknown');
  }, 1_000_000, false); store = f.store;
  assert.equal((await f.steward.propose(ask)).status, 'held'); assert.equal(sends, 1);
  const state = await store.read(); assert.equal(state.requests[ask.requestId].provider.httpStatus, 429);
  assert.ok(state.reservedMicros > 0); assert.ok(!JSON.stringify(state).includes('private provider error'));
  await assert.rejects(hostedTransport({ store, requestId: ask.requestId, inputDigest: 'bad', sessionId: 'other', send: () => { sends++; } })(endpoint, wire()), /ADMISSION_DENIED/);
  assert.equal(sends, 1);
});

test('provider budget and pause deny before I/O, without spending the allowance', async t => {
  for (const pause of [false, true]) {
    let store; let sends = 0;
    const f = await fixture(t, async input => {
      if (pause) await store.change(state => { state.paused = true; });
      return hostedTransport({ store, requestId: input.hostedRequestId, inputDigest: digest(input), sessionId: 'test', send: () => { sends++; } })(endpoint, wire());
    }, pause ? 1_000_000 : 0, false); store = f.store;
    assert.equal((await f.steward.propose(ask)).status, 'held');
    assert.equal(sends, 0); assert.equal((await store.read()).reservedMicros, 0);
  }
});

test('real Better Auth rejects public signup, wrong password, foreign owner and CSRF; sessions persist across auth instances', async t => {
  const pool = new TestPool(); t.after(() => pool.end());
  await setupHosted(pool, { origin, secret, ownerEmail, password, project, budgetMicros: 0 });
  const store = new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id });
  let calls = 0; const steward = new HostedSteward(store, async input => { calls++; await store.change(state => { state.requests[input.hostedRequestId].provider = { intentAt: now(), httpStatus: 200, sessionId: 'synthetic-session', reservedMicros: 1 }; state.reservedMicros += 1; }); return proposal; }, { now });
  const auth = ownerAuth(pool, { origin, secret });
  const handle = hostedHandler({ auth, steward, ownerEmail, origin });
  const req = (path, body, cookie, from = origin) => new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin: from, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), 'x-forwarded-for': '127.0.0.1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await handle(req('/api/steward/state'))).status, 401);
  assert.equal((await handle(req('/api/auth/sign-up/email', { email: 'bad@example.com', password }))).status, 404);
  assert.equal((await handle(req('/api/auth/sign-in/email', { email: ownerEmail, password: 'wrong' }))).status, 401);
  const login = await handle(req('/api/auth/sign-in/email', { email: ownerEmail, password }));
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; '); assert.ok(cookie);
  assert.equal((await handle(req('/api/steward/state', undefined, cookie))).status, 200);
  assert.equal((await handle(req('/api/steward/propose', ask, cookie, 'https://evil.example'))).status, 403);
  for (const path of ['/api/steward/continuation/review', '/api/steward/continuation/approve', '/api/steward/context/preview', '/api/steward/context/apply', '/api/steward/coding/review', '/api/steward/coding/approve', '/api/steward/coding/reconcile', '/api/steward/coding/observe', '/api/steward/coding/release']) {
    assert.equal((await handle(req(path, {}))).status, 401);
    assert.equal((await handle(req(path, {}, cookie, 'https://evil.example'))).status, 403);
  }
  const restarted = hostedHandler({ auth: ownerAuth(pool, { origin, secret }), steward, ownerEmail, origin });
  assert.equal((await restarted(req('/api/steward/state', undefined, cookie))).status, 200);
  const otherOwner = hostedHandler({ auth, steward, ownerEmail: 'different@example.com', origin });
  assert.equal((await otherOwner(req('/api/steward/state', undefined, cookie))).status, 401);
  assert.equal(calls, 0);
  assert.equal((await handle(req('/api/steward/propose', ask, cookie))).status, 200); assert.equal(calls, 1);
  const state = await (await handle(req('/api/steward/state', undefined, cookie))).json();
  assert.ok(!JSON.stringify(state).includes(password));
  assert.equal((await handle(req('/api/auth/sign-out', {}, cookie))).status, 200);
  assert.equal((await restarted(req('/api/steward/state', undefined, cookie))).status, 401);
});


test('a fixture or alternate Eve service cannot produce a hosted result without admitted provider evidence', async t => {
  const { steward, store } = await fixture(t, async () => proposal, 1_000_000, false);
  assert.equal((await steward.propose(ask)).status, 'held');
  assert.equal((await store.read()).reservedMicros, 0);
});

test('successful hosted inference uses the durable reservation; oversized wire fails before send', async t => {
  for (const oversized of [false, true]) {
    let store; let sends = 0;
    const f = await fixture(t, async input => {
      const body = wire();
      if (oversized) { const parsed = JSON.parse(body.body); parsed.prompt[0].content = 'x'.repeat(12001); body.body = JSON.stringify(parsed); }
      const transport = hostedTransport({ store, requestId: input.hostedRequestId, inputDigest: digest(input), sessionId: 'synthetic-paid-step', send: async (_url, init) => {
        sends++; const parsed = JSON.parse(init.body);
        assert.deepEqual(parsed.providerOptions.gateway, { only: ['anthropic'], models: [], byok: {} });
        assert.equal(parsed.tools[0].strict, true);
        return new Response('synthetic stream', { status: 200 });
      } });
      await transport(endpoint, body);
      return proposal;
    }, 1_000_000, false); store = f.store;
    const result = await f.steward.propose(ask);
    assert.equal(result.status, oversized ? 'held' : 'awaiting_approval');
    assert.equal(sends, oversized ? 0 : 1);
    assert.equal((await store.read()).reservedMicros > 0, !oversized);
  }
});

test('hosted pilot cannot start a sixth admitted model attempt', async t => {
  const { store, steward } = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await steward.propose({ ...ask, requestId: `request-${i}` })).status, 'awaiting_approval');
  await assert.rejects(steward.propose({ ...ask, requestId: 'request-six' }), /ADMISSION_PAUSED/);
  assert.equal(Object.keys((await store.read()).requests).length, 5);
});

async function rejectedFixture(t) {
  const f = await fixture(t, async () => undefined);
  await f.steward.propose(ask);
  await f.store.change(s => { Object.assign(s.requests[ask.requestId].provider, { httpStatus: 429, rejection: { httpStatus: 429, errorCategory: 'rate_limit_exceeded', retryAfter: null } }); });
  const r = (await f.steward.view()).requests[0];
  const recovery = { ...ask, requestId: 'retry-one', expectedContextRevision: r.contextRevision, retryOf: r.id, rejectionHash: r.retryReviewHash };
  let sends = 0;
  const steward = new HostedSteward(f.store, async input => {
    await hostedTransport({ store: f.store, requestId: input.hostedRequestId, inputDigest: digest(input), sessionId: 'retry-session', now, send: async () => { sends++; return new Response('synthetic', { status: 200 }); } })(endpoint, wire());
    return proposal;
  }, { now });
  return { ...f, steward, recovery, sends: () => sends };
}

test('explicit rejection recovery keeps old evidence and accounting, admits one new request, and never replays', async t => {
  const f = await rejectedFixture(t); const before = await f.store.read();
  const [a, b] = await Promise.all([f.steward.propose(f.recovery), f.steward.propose(f.recovery)]);
  assert.ok([a, b].some(r => r.status === 'awaiting_approval'));
  assert.equal(f.sends(), 1);
  const after = await f.store.read();
  assert.deepEqual(after.requests[ask.requestId], { ...before.requests[ask.requestId], retryRequestId: 'retry-one' });
  assert.equal(after.requests['retry-one'].retryOf, ask.requestId);
  assert.equal(after.reservedMicros, before.reservedMicros + after.requests['retry-one'].provider.reservedMicros);
  const restarted = new HostedSteward(f.store, () => { throw Error('must never send'); }, { now });
  assert.equal((await restarted.propose(f.recovery)).status, 'awaiting_approval');
  await assert.rejects(restarted.propose({ ...f.recovery, requestId: 'retry-two' }), /RETRY_REVIEW_MISMATCH/);
  await assert.rejects(restarted.propose({ ...ask, requestId: 'retry-one' }), /REQUEST_ID_CONFLICT/);
  assert.equal((await restarted.view()).requests.find(r => r.id === ask.requestId).retryReviewHash, null);
});

test('retry review binds request, context, model and rejection evidence', async t => {
  for (const change of [r => { r.message = 'Changed request'; }, r => { r.rejectionHash = 'a'.repeat(64); }, r => { delete r.expectedContextRevision; }, r => { r.retryOf = 'missing'; }]) {
    const f = await rejectedFixture(t); change(f.recovery);
    await assert.rejects(f.steward.propose(f.recovery), /RETRY_REVIEW_MISMATCH/); assert.equal(f.sends(), 0);
  }
  for (const change of [s => { s.model = 'different-model'; }, s => { s.project.revision = 'changed'; }, s => { s.requests[ask.requestId].provider.rejection.retryAfter = { kind: 'seconds', seconds: 30 }; }]) {
    const f = await rejectedFixture(t); await f.store.change(change);
    await assert.rejects(f.steward.propose(f.recovery), /RETRY_REVIEW_MISMATCH|INVALID_REQUEST/); assert.equal(f.sends(), 0);
  }
});

test('unknown, invalid-success, spend-cap and in-flight failures cannot become retry approvals', async t => {
  for (const change of [r => { delete r.provider.httpStatus; }, r => { r.provider.httpStatus = 200; }, r => { r.status = 'thinking'; }, r => { delete r.completedAt; }, r => { r.provider.rejection.providerErrorCode = 'enforced_spend_limit_reached'; }, r => { r.provider.rejection.errorCategory = null; }]) {
    const f = await rejectedFixture(t); await f.store.change(s => change(s.requests[ask.requestId]));
    assert.equal((await f.steward.view()).requests[0].retryReviewHash, null);
    await assert.rejects(f.steward.propose(f.recovery), /RETRY_REVIEW_MISMATCH/); assert.equal(f.sends(), 0);
  }
});

test('recovery respects Retry-After and cannot bypass another unresolved request, pause, attempt cap, expiry or budget', async t => {
  for (const [change, expected] of [
    [s => { s.paused = true; }, /ADMISSION_PAUSED/],
    [s => { s.project.sources[0].expiresAt = '2026-09-18T00:00:00Z'; }, /CONTEXT_EXPIRED/],
    [s => { s.requests.other = { id: 'other', status: 'held' }; }, /UNRESOLVED_MODEL_ATTEMPT/],
    [s => { for (let i = 0; i < 4; i++) s.requests[`prior-${i}`] = { id: `prior-${i}`, status: 'approved', provider: { intentAt: now() } }; }, /ADMISSION_PAUSED/],
  ]) {
    const f = await rejectedFixture(t); await f.store.change(change);
    await assert.rejects(f.steward.propose(f.recovery), expected); assert.equal(f.sends(), 0);
  }
  for (const after of [{ kind: 'seconds', seconds: 30 }, { kind: 'date', at: '2026-09-19T13:00:00Z' }]) {
    const f = await rejectedFixture(t); await f.store.change(s => { s.requests[ask.requestId].provider.rejection.retryAfter = after; });
    f.recovery.rejectionHash = (await f.steward.view()).requests[0].retryReviewHash;
    await assert.rejects(f.steward.propose(f.recovery), /RETRY_NOT_READY/); assert.equal(f.sends(), 0);
  }
  const f = await rejectedFixture(t); await f.store.change(s => { s.budgetMicros = s.reservedMicros; });
  assert.equal((await f.steward.propose(f.recovery)).status, 'held'); assert.equal(f.sends(), 0);
  assert.equal((await f.store.read()).reservedMicros, 1);
});

test('competing retry IDs cannot consume the same rejection twice', async t => {
  const f = await rejectedFixture(t);
  const results = await Promise.allSettled([f.steward.propose(f.recovery), f.steward.propose({ ...f.recovery, requestId: 'retry-competing' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && /RETRY_REVIEW_MISMATCH/.test(r.reason.message)).length, 1);
  assert.equal(f.sends(), 1);
});

test('a rejected recovery remains held and cannot chain or trigger automatic attempts', async t => {
  const f = await rejectedFixture(t); let sends = 0;
  const steward = new HostedSteward(f.store, async input => hostedTransport({ store: f.store, requestId: input.hostedRequestId,
    inputDigest: digest(input), sessionId: 'rejected-retry', now, send: async () => { sends++; return new Response('{"error":{"type":"rate_limit_exceeded"}}', { status: 429 }); } })(endpoint, wire()), { now });
  assert.equal((await steward.propose(f.recovery)).status, 'held');
  assert.equal((await steward.propose(f.recovery)).status, 'held'); assert.equal(sends, 1);
  const child = (await steward.view()).requests.find(r => r.id === 'retry-one');
  await assert.rejects(steward.propose({ ...f.recovery, requestId: 'retry-again', retryOf: child.id, rejectionHash: child.retryReviewHash }), /UNRESOLVED_MODEL_ATTEMPT/);
  assert.equal(sends, 1);
});
