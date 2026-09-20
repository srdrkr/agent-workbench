import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from 'eve/client';
import { z } from 'zod';
import { judgmentObservation } from '../stream-policy.js';
import { createEveJudge } from '../judge.js';
import { inspectEvalResult } from '../eval-gateway.js';
import { initializeLedger, beginCase, openLedger, ledgerSummary, EVAL_MODEL } from '../eval-ledger.js';
import { evalTransport } from '../eval-transport.js';
import { proposalSchema } from '../schema.js';

const repo = resolve(import.meta.dirname, '../../..');
const project = JSON.parse(readFileSync(join(repo, 'fixtures/steward-project.json'), 'utf8'));
const cases = JSON.parse(readFileSync(join(repo, 'fixtures/steward-evals.json'), 'utf8')).cases;
const proposal = { kind: 'coding', candidateId: 'normalize', title: 'Normalize whitespace',
  rationale: 'Synthetic bounded proposal.', citations: ['brief', 'acceptance'], question: null };
const sessionId = 'wrun_synthetic_recovery';
const authToken = 'synthetic-observation-credential';
const streamPath = `/eve/v1/session/${sessionId}/stream`;

// Real installed Eve Client over loopback. Only the Gateway send function is
// fake; the real SQLite admission guards every simulated provider invocation.
async function fixture(mode) {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-stream-recovery-'));
  const ledgerPath = join(dir, 'run.sqlite');
  initializeLedger(ledgerPath, { project, cases, mode: 'live', fixtureHash: 'synthetic' });
  const db = openLedger(ledgerPath);
  const record = beginCase(db, 'next-step');
  const state = { posts: 0, providerCalls: 0, gets: [], events: [], errors: [] };
  const active = new Set();
  let timer;
  const emit = (type, data = {}) => {
    const event = { type, data, meta: { id: `evt_synthetic_${state.events.length}`, at: new Date().toISOString() } };
    state.events.push(event);
    for (const response of active) response.write(`${JSON.stringify(event)}\n`);
  };
  const finish = () => {
    emit('step.completed', { usage: { inputTokens: 100, outputTokens: 50 } });
    emit('result.completed', { result: proposal });
    emit('turn.completed');
    emit('session.waiting');
    for (const response of active) response.end();
  };
  const request = { method: 'POST', headers: { 'ai-language-model-id': EVAL_MODEL }, body: JSON.stringify({
    maxOutputTokens: 2048, prompt: [{ role: 'user', content: record.message }],
    tools: [{ type: 'function', name: 'final_output', inputSchema: z.toJSONSchema(proposalSchema) }],
  }) };
  const sendOnce = () => evalTransport({ ledgerPath, caseId: record.id, sessionId, messageHash: record.message_hash,
    send: async () => { state.providerCalls++; return new Response(); } })('https://ai-gateway.vercel.sh/v4/ai/language-model', request);
  const server = createServer((req, res) => {
    (async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/eve/v1/session') {
        state.posts++;
        for await (const _chunk of req) { /* drain synthetic input */ }
        await sendOnce();
        emit('step.started');
        if (mode === 'deadline') emit('result.completed', { result: proposal });
        if (mode === 'quiet') timer = setTimeout(finish, 17_000);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sessionId }));
        return;
      }
      assert.equal(req.method, 'GET');
      assert.equal(url.pathname, streamPath);
      const startIndex = Number(url.searchParams.get('startIndex') ?? 0);
      state.gets.push({ path: url.pathname, startIndex });
      if (mode === 'transient' && state.gets.length === 2) { res.writeHead(503); res.end('synthetic'); return; }
      if (['socket', 'transient'].includes(mode) && state.gets.length >= (mode === 'transient' ? 3 : 2)) finish();
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.flushHeaders();
      for (const event of state.events.slice(startIndex)) res.write(`${JSON.stringify(event)}\n`);
      if (mode === 'socket' && state.gets.length === 1) {
        res.write('{"type":"result.'); // Incomplete event must not advance cursor.
        timer = setTimeout(() => res.destroy(), 25);
      } else if (state.events.some(event => event.type === 'session.waiting') || ['transient', 'empty'].includes(mode)) res.end();
      else { active.add(res); res.once('close', () => active.delete(res)); }
    })().catch(error => { state.errors.push(error); res.destroy(); });
  });
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  const host = `http://127.0.0.1:${server.address().port}`;
  const client = () => new Client({ host, auth: { bearer: authToken }, redirect: 'error' });
  return { state, db, host, client, finish, sendOnce, record,
    async close() { clearTimeout(timer); server.closeAllConnections(); await new Promise(done => server.close(done)); db.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

function assertSingleDispatch(f) {
  assert.equal(f.state.posts, 1);
  assert.equal(f.state.providerCalls, 1);
  assert.equal(ledgerSummary(f.db).cases.filter(item => item.reservedMicros > 0).length, 1);
  assert.deepEqual(f.state.errors, []);
}

test('real 15-second SDK idle cutoff recovers the same cursor without another dispatch', { timeout: 30_000 }, async () => {
  const f = await fixture('quiet');
  try {
    const { response } = await f.client().sessions.create({ message: f.record.message, outputSchema: proposalSchema, ...judgmentObservation(25_000) });
    const result = await response.result();
    assert.equal(inspectEvalResult(result, 200000).completed, true);
    assert.deepEqual(f.state.gets.map(item => item.startIndex), [0, 1]);
    assert.equal(new Set(result.events.map(event => event.meta.id)).size, result.events.length);
    assertSingleDispatch(f);
  } finally { await f.close(); }
});

test('partial disconnect and transient GET failure recover without replaying the POST', async () => {
  const f = await fixture('transient');
  try {
    const judge = await createEveJudge({ enabled: true, host: f.host, authToken, timeoutMs: 5000 });
    assert.deepEqual(await judge({ request: 'Next step?', project: { ...project, revision: 'synthetic' }, commitments: [] }), proposal);
    assert.deepEqual(f.state.gets.map(item => item.startIndex), [0, 1, 1]);
    assertSingleDispatch(f);
  } finally { await f.close(); }
});

test('broken socket discards an incomplete event and resumes after the last complete event', async () => {
  const f = await fixture('socket');
  try {
    const { response } = await f.client().sessions.create({ message: f.record.message, ...judgmentObservation(5000) });
    const result = await response.result();
    assert.equal(inspectEvalResult(result, 200000).completed, true);
    assert.deepEqual(f.state.gets.map(item => item.startIndex), [0, 1]);
    assert.equal(new Set(result.events.map(event => event.meta.id)).size, result.events.length);
    assertSingleDispatch(f);
  } finally { await f.close(); }
});

test('empty reconnects exhaust their bound without falsely completing', async () => {
  const f = await fixture('empty');
  try {
    const { response } = await f.client().sessions.create({ message: f.record.message, ...judgmentObservation(5000) });
    const result = await response.result();
    assert.equal(result.status, 'completed'); // Known Eve behavior, never enough.
    assert.equal(inspectEvalResult(result, 200000).completed, false);
    assert.deepEqual(f.state.gets.map(item => item.startIndex), [0, 1, 1]);
    assertSingleDispatch(f);
  } finally { await f.close(); }
});

test('deadline after structured output but before turn completion remains held', async () => {
  const f = await fixture('deadline');
  try {
    const judge = await createEveJudge({ enabled: true, host: f.host, authToken, timeoutMs: 200 });
    await assert.rejects(judge({ request: 'Next step?', project: { ...project, revision: 'synthetic' }, commitments: [] }), /^Error: JUDGE_UNAVAILABLE_OR_INVALID$/);
    const inspected = inspectEvalResult({ status: 'completed', data: proposal, events: f.state.events }, 200000);
    assert.equal(inspected.evidence.completion.schemaValid, true);
    assert.equal(inspected.evidence.completion.turnCompleted, false);
    assert.equal(inspected.completed, false);
    assertSingleDispatch(f);
  } finally { await f.close(); }
});

test('a new observer reads the saved session cursor while fresh provider admission remains denied', async () => {
  const f = await fixture('empty');
  try {
    const created = await f.client().sessions.create({ message: f.record.message, signal: AbortSignal.timeout(5000), streamReconnectPolicy: { reconnect: false } });
    const partial = await created.response.result();
    assert.equal(inspectEvalResult(partial, 200000).completed, false);
    const savedCursor = created.session.state.streamIndex;
    assert.equal(savedCursor, 1);
    f.finish();
    // Simulate loss of the client object, not resubmission of its create call.
    const observer = f.client().sessions.attach(sessionId, { streamIndex: savedCursor });
    const events = [...partial.events];
    for await (const event of observer.stream(judgmentObservation(5000))) {
      events.push(event);
      if (event.type === 'session.waiting') break;
    }
    assert.equal(inspectEvalResult({ status: 'waiting', data: proposal, events }, 200000).completed, true);
    assert.equal(new Set(events.map(event => event.meta.id)).size, events.length);
    assert.deepEqual(f.state.gets.map(item => item.startIndex), [0, 1]);
    await assert.rejects(f.sendOnce(), /EVAL_PROVIDER_ADMISSION_DENIED/);
    assertSingleDispatch(f);
  } finally { await f.close(); }
});
