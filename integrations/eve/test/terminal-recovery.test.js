import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { TestPool } from './pg-fixture.js';
import { HostedStore, stateSchema } from '../hosted/store.js';
import { HostedSteward, initialState } from '../hosted/steward.js';
import { terminalObservationHash } from '../hosted/recovery.js';
import { createSessionObserver } from '../hosted/session-observer.js';
import { hostedHandler } from '../hosted/http.js';
import { ownerAuth } from '../hosted/auth.js';
import { setupHosted } from '../hosted/setup.js';
import { statusSummary } from '../shared/status-summary.js';

const project = JSON.parse(await readFile(new URL('../../../fixtures/steward-project.json', import.meta.url)));
const sessionId = 'wrun_synthetic_terminal'; const requestId = 'terminal-draft';
const at = '2026-09-24T12:00:00.000Z'; const now = () => '2026-09-24T12:01:00.000Z';
const authToken = 'synthetic-observer-secret-12345'; const ownerEmail = 'owner@example.com'; const origin = 'http://localhost:4399';
function events() {
  const data = [{ runtime: { agentId: 'workbench-eve-judge' } }, { sequence: 0, turnId: 'turn_0' },
    { sequence: 0, turnId: 'turn_0', message: JSON.stringify({ hostedRequestId: requestId, request: 'synthetic-private-context' }) },
    { sequence: 0, turnId: 'turn_0', stepIndex: 0 }, { sequence: 0, turnId: 'turn_0', stepIndex: 0 },
    { sequence: 0, turnId: 'turn_0', stepIndex: 1, code: 'MODEL_SELECTION_FAILED', message: 'JUDGE_STEP_LIMIT' },
    { sequence: 0, turnId: 'turn_0', code: 'MODEL_SELECTION_FAILED', message: 'JUDGE_STEP_LIMIT' },
    { sessionId, code: 'MODEL_SELECTION_FAILED', message: 'JUDGE_STEP_LIMIT' }];
  return 'session.started,turn.started,message.received,step.started,step.completed,step.failed,turn.failed,session.failed'
    .split(',').map((type, i) => ({ type, data: data[i], meta: { at } }));
}
async function fixture(t, { authenticated = false } = {}) {
  let emitted = events(); let tail = '7'; let truncated = false; let bytes = 0; let hang = false; let newline = true; let blank = false; const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    assert.equal(req.headers.authorization, `Bearer ${authToken}`);
    res.writeHead(200, { 'content-type': 'application/x-ndjson', ...(tail === null ? {} : { 'x-eve-stream-tail-index': tail }) });
    if (hang) { res.flushHeaders(); return; }
    const body = emitted.map(e => JSON.stringify(e)).join('\n') + (newline ? '\n' : '') + 'x'.repeat(bytes);
    res.end(blank ? '\n' + body : truncated ? body.slice(0, body.lastIndexOf('session.failed') - 12) : body);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const observeSession = createSessionObserver({ enabled: true, host: `http://127.0.0.1:${server.address().port}`, authToken, timeoutMs: 500 });
  const pool = new TestPool(); t.after(() => pool.end());
  if (authenticated) await setupHosted(pool, { origin, secret: authToken + '-auth', ownerEmail, password: 'synthetic-password-123', project, budgetMicros: 1_000_000 });
  else { await pool.query(stateSchema); await new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id }).initialize(initialState(project, { model: 'anthropic/claude-opus-5', budgetMicros: 1_000_000 })); }
  const store = new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id });
  await store.change(s => { s.requests[requestId] = { id: requestId, projectId: project.id, mode: 'assignment_draft', status: 'held', inputHash: 'synthetic',
    contextRevision: s.project.revision, message: 'Preserve the original request', createdAt: at, completedAt: at,
    provider: { intentAt: at, sessionId, httpStatus: 200, reservedMicros: 1000 } }; s.reservedMicros = 1000; });
  const steward = new HostedSteward(store, () => assert.fail('no model call'), { now, observeSession });
  return { store, steward, pool, requests, observeSession, set: fn => { emitted = events(); fn(emitted); },
    tail: v => { tail = v; }, truncated: v => { truncated = v; }, hang: v => { hang = v; }, newline: v => { newline = v; }, blank: v => { blank = v; }, oversized: () => { emitted[2].data.message = 'x'.repeat(131073); } };
}
async function current(f) { return (await f.steward.view()).requests.find(r => r.id === requestId); }
async function observe(f) { const r = await current(f); return f.steward.observeTerminalFailure({ requestId, observationHash: r.recovery.observationHash }); }

test('real bounded stream observation and acknowledgement preserve intent, reservation and history, with only two GETs', async t => {
  const f = await fixture(t); const before = await f.store.read();
  assert.equal((await current(f)).recovery.action, 'observe');
  await observe(f); const r = await current(f);
  assert.equal(r.recovery.case, 'terminal_failure'); assert.equal(r.recovery.action, 'acknowledge');
  assert.match(statusSummary(await f.steward.view()), /acknowledge the failed judgment/);
  assert.doesNotMatch(JSON.stringify(r.terminalObservation), /synthetic-private-context/);
  const input = { requestId, acknowledgeHash: r.recovery.acknowledgeHash };
  const observed = JSON.stringify(await f.store.read());
  await assert.rejects(f.steward.acknowledgeRejectedReview(input), /RECOVERY_NOT_SUPPORTED/);
  await assert.rejects(f.steward.observeTerminalFailure({ requestId, observationHash: input.acknowledgeHash }), /RECOVERY_REVIEW_STALE/);
  assert.equal(JSON.stringify(await f.store.read()), observed); assert.equal(f.requests.length, 1);
  const done = await f.steward.acknowledgeTerminalFailure(input);
  assert.equal(done.status, 'failure_acknowledged');
  assert.deepEqual(await f.steward.acknowledgeTerminalFailure(input), done);
  assert.deepEqual(f.requests.map(r => r.method), ['GET', 'GET']);
  assert.ok(f.requests.every(r => r.url === `/eve/v1/session/${sessionId}/stream?includeTailIndex=1`));
  const after = await f.store.read();
  assert.deepEqual(after.requests[requestId].provider, before.requests[requestId].provider);
  assert.equal(after.requests[requestId].message, before.requests[requestId].message);
  assert.equal(after.requests[requestId].inputHash, before.requests[requestId].inputHash);
  assert.equal(after.requests[requestId].contextRevision, before.requests[requestId].contextRevision);
  assert.equal(after.reservedMicros, before.reservedMicros); assert.equal(after.budgetMicros, before.budgetMicros);
  assert.deepEqual(after.project, before.project); assert.deepEqual(after.coding, before.coding);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.equal(after.events.length, before.events.length + 2);
  const reopened = new HostedSteward(new HostedStore(f.pool, { ownerId: ownerEmail, projectId: project.id }), () => assert.fail('no call'), { now, observeSession: f.observeSession });
  assert.equal((await reopened.view()).requests[0].status, 'failure_acknowledged');
  assert.match(statusSummary(await reopened.view()), /start a fresh request/);
});

test('ongoing, completed, other-session, other-request, unsupported, truncated and oversized streams remain held', async t => {
  const f = await fixture(t); const before = JSON.stringify(await f.store.read());
  const changes = [e => e[7].type = 'session.waiting', e => e[4].type = 'result.completed',
    e => e[7].data.sessionId = 'wrun_someone_else', e => e[2].data.message = JSON.stringify({ hostedRequestId: 'other' }),
    e => e[6].data.message = 'private arbitrary provider error', e => e[1].data.sequence = 1];
  for (const change of changes) { f.set(change); await assert.rejects(observe(f), /^Error: RECOVERY_EVIDENCE_UNAVAILABLE$/); }
  f.set(() => {}); f.tail(null); await assert.rejects(observe(f), /RECOVERY_EVIDENCE_UNAVAILABLE/);
  f.tail('7'); f.blank(true); assert.equal((await f.observeSession({ requestId, sessionId })).eventCount, 8); f.blank(false);
  f.newline(false); await assert.rejects(observe(f), /RECOVERY_EVIDENCE_UNAVAILABLE/); f.newline(true);
  f.hang(true); await assert.rejects(observe(f), /RECOVERY_EVIDENCE_UNAVAILABLE/); f.hang(false);
  f.set(e => e.forEach(x => x.meta.at = '2026-09-23T00:00:00.000Z')); await assert.rejects(observe(f), /RECOVERY_EVIDENCE_UNAVAILABLE/);
  f.set(e => e.forEach(x => x.meta.at = '2026-09-25T00:00:00.000Z')); await assert.rejects(observe(f), /RECOVERY_EVIDENCE_UNAVAILABLE/);
  f.set(() => {}); f.tail('8'); await assert.rejects(observe(f), /RECOVERY_EVIDENCE_UNAVAILABLE/);
  f.tail('7'); f.truncated(true); await assert.rejects(observe(f), /RECOVERY_EVIDENCE_UNAVAILABLE/);
  f.truncated(false); f.oversized(); await assert.rejects(observe(f), /RECOVERY_EVIDENCE_UNAVAILABLE/);
  assert.equal(JSON.stringify(await f.store.read()), before);
});

test('acknowledgement rechecks the tail and stale reviews, changed receipts, retry chains and coding reviews fail closed', async t => {
  const f = await fixture(t); await observe(f); const r = await current(f);
  const input = { requestId, acknowledgeHash: r.recovery.acknowledgeHash };
  f.tail('8'); await assert.rejects(f.steward.acknowledgeTerminalFailure(input), /RECOVERY_EVIDENCE_UNAVAILABLE/);
  assert.equal((await current(f)).status, 'held'); f.tail('7');
  await assert.rejects(f.steward.acknowledgeTerminalFailure({ ...input, acknowledgeHash: 'f'.repeat(64) }), /RECOVERY_REVIEW_STALE/);
  const state = await f.store.read();
  for (const changes of [{ purpose: 'coding_review' }, { retryOf: 'old' }, { retryRequestId: 'retry' }, { proposal: {} }, { status: 'thinking' }, { mode: 'other' }]) {
    const record = { ...state.requests[requestId], ...changes };
    assert.equal(terminalObservationHash(state, record), null);
  }
  assert.equal(terminalObservationHash({ ...state, reservedMicros: 0 }, { ...state.requests[requestId], terminalObservation: undefined }), null);
  await f.store.change(s => s.requests[requestId].provider.reservedMicros++);
  await assert.rejects(f.steward.acknowledgeTerminalFailure(input), /RECOVERY_REVIEW_STALE/);
  assert.equal((await current(f)).status, 'held');
});

test('observation race cannot rewrite changed intent; expired context and pauses survive acknowledgement', async t => {
  const f = await fixture(t); let mutate = true;
  const steward = new HostedSteward(f.store, () => assert.fail('no call'), { now, observeSession: async input => {
    const receipt = await f.observeSession(input); if (mutate) await f.store.change(s => s.requests[requestId].inputHash = 'changed'); return receipt;
  } });
  const r = (await steward.view()).requests[0];
  await assert.rejects(steward.observeTerminalFailure({ requestId, observationHash: r.recovery.observationHash }), /RECOVERY_REVIEW_STALE/);
  assert.equal((await current(f)).terminalObservation, undefined); mutate = false;
  await observe(f);
  await f.store.change(s => { s.paused = true; s.project.sources[0].expiresAt = '2026-09-23T00:00:00.000Z'; });
  const held = await current(f);
  await f.steward.acknowledgeTerminalFailure({ requestId, acknowledgeHash: held.recovery.acknowledgeHash });
  const s = await f.store.read(); assert.equal(s.paused, true); assert.equal(s.project.sources[0].expiresAt, '2026-09-23T00:00:00.000Z');
  await assert.rejects(f.steward.propose({ requestId: 'new', projectId: project.id, message: 'new' }), /ADMISSION_PAUSED/);
});

test('both new HTTP operations require owner auth and exact origin before reading the provider stream', async t => {
  const f = await fixture(t, { authenticated: true });
  const handle = hostedHandler({ auth: ownerAuth(f.pool, { origin, secret: authToken + '-auth' }), steward: f.steward, ownerEmail, origin });
  const req = (path, body, cookie, from = origin) => new Request(origin + path, { method: 'POST', headers: { origin: from, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const login = await handle(req('/api/auth/sign-in/email', { email: ownerEmail, password: 'synthetic-password-123' }));
  const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  for (const path of ['/api/steward/recovery/observe-terminal-failure', '/api/steward/recovery/acknowledge-terminal-failure']) {
    assert.equal((await handle(req(path, {}))).status, 401);
    assert.equal((await handle(req(path, {}, cookie, 'https://evil.example'))).status, 403);
  }
  assert.equal(f.requests.length, 0);
  const r = await current(f);
  assert.equal((await handle(req('/api/steward/recovery/observe-terminal-failure', { requestId, observationHash: r.recovery.observationHash }, cookie))).status, 200);
  const observed = await current(f);
  const beforeLegacy = JSON.stringify(await f.store.read());
  const refused = await handle(req('/api/steward/recovery/acknowledge', { requestId, acknowledgeHash: observed.recovery.acknowledgeHash }, cookie));
  assert.equal(refused.status, 409); assert.equal((await refused.json()).error, 'RECOVERY_NOT_SUPPORTED');
  assert.equal(JSON.stringify(await f.store.read()), beforeLegacy); assert.equal(f.requests.length, 1);
  assert.equal((await handle(req('/api/steward/recovery/acknowledge-terminal-failure', { requestId, acknowledgeHash: observed.recovery.acknowledgeHash }, cookie))).status, 200);
  assert.equal(f.requests.length, 2);
});

test('a missing observer suppresses the action and reports unsupported capability without a stream read', async t => {
  const f = await fixture(t); const steward = new HostedSteward(f.store, () => assert.fail('no call'), { now });
  const r = (await steward.view()).requests[0]; assert.equal(r.recovery.action, 'none');
  await assert.rejects(steward.observeTerminalFailure({ requestId, observationHash: 'f'.repeat(64) }), /RECOVERY_NOT_SUPPORTED/);
  assert.equal(f.requests.length, 0);
});
