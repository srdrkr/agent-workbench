import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { Steward } from '../src/steward.js';
import { createStewardServer } from '../src/steward-server.js';
import { demoJudge } from '../src/steward-demo.js';

const project = JSON.parse(readFileSync(new URL('../fixtures/steward-project.json', import.meta.url)));
const ownerKey = 'synthetic-test-owner-key';

async function setup(t) {
  const steward = new Steward(':memory:', { judge: demoJudge, now: () => '2026-09-17T12:00:00.000Z' });
  steward.importProject(project);
  const server = createStewardServer({ steward, ownerKey, port: 0 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); steward.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = request(`${origin}${path}`, { method, headers, agent: false }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject); req.end(body);
  });
  const launch = () => send('/api/launch', { method: 'POST', headers: { authorization: `Bearer ${ownerKey}` } });
  const redeem = ticket => send('/launch', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket }).toString() });
  const login = async () => {
    const launched = await launch(); assert.equal(launched.status, 200);
    const redeemed = await redeem(launched.body.ticket); assert.equal(redeemed.status, 303);
    const cookie = redeemed.headers['set-cookie'][0].split(';')[0];
    const state = await send('/api/state', { headers: { cookie } }); assert.equal(state.status, 200);
    return { cookie, csrf: state.body.csrf };
  };
  const action = (path, input, { cookie, csrf }, headers = {}) => send(path, { method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json', 'x-workbench-csrf': csrf, ...headers }, body: JSON.stringify(input) });
  return { steward, origin, send, launch, redeem, login, action };
}

test('local HTTP state and actions require authentication and an exact host', async t => {
  const { send, origin } = await setup(t);
  assert.equal((await send('/api/state')).status, 401);
  assert.equal((await send('/api/state', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await send('/api/launch', { method: 'POST' })).status, 401);
  assert.equal((await send('/api/launch', { method: 'POST', headers: { authorization: 'Bearer wrong-key' } })).status, 401);
  const forged = await send('/api/approve', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ owner: 'local-owner', requestId: 'forged', proposalHash: 'forged' }) });
  assert.equal(forged.status, 401);
});

test('owner key issues a single-use ticket and a protected session cookie', async t => {
  const { launch, redeem, send } = await setup(t);
  const launched = await launch();
  assert.equal(launched.status, 200);
  assert.match(launched.body.ticket, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(launched.body).includes(ownerKey));
  const redeemed = await redeem(launched.body.ticket);
  assert.equal(redeemed.status, 303);
  assert.equal(redeemed.headers.location, '/');
  const setCookie = redeemed.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Path=\//);
  assert.equal((await redeem(launched.body.ticket)).status, 401);
  const state = await send('/api/state', { headers: { cookie: setCookie.split(';')[0] } });
  assert.equal(state.status, 200);
  assert.match(state.body.csrf, /^[a-f0-9]{64}$/);
  assert.equal(state.headers['cache-control'], 'no-store');
  assert.ok(!JSON.stringify(state.body).includes(ownerKey));
});

test('authenticated mutations require exact origin, JSON content type, and CSRF token', async t => {
  const { steward, login, action, send } = await setup(t);
  const session = await login();
  const proposal = { requestId: 'request-1', projectId: project.id, message: 'What should we do next?' };
  for (const headers of [{ origin: 'http://evil.example' }, { origin: '' },
    { 'x-workbench-csrf': 'wrong' }, { 'x-workbench-csrf': '' }, { 'content-type': 'text/plain' }]) {
    const rejected = await action('/api/propose', proposal, session, headers);
    assert.equal(rejected.status, 403);
  }
  assert.equal(steward.view().requests.length, 0);
  const loggedOut = await action('/api/logout', {}, session);
  assert.equal(loggedOut.status, 200);
  assert.equal((await send('/api/state', { headers: { cookie: session.cookie } })).status, 401);
});

test('authenticated proposal, approval, lost response, and reconciliation stay synthetic', async t => {
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { providerCalls++; throw new Error('Unexpected external provider call'); });
  const { steward, login, action, send } = await setup(t);
  const session = await login();
  const proposed = await action('/api/propose', { requestId: 'request-1', projectId: project.id, message: 'What should we do next?' }, session);
  assert.equal(proposed.status, 200);
  assert.equal(proposed.body.status, 'awaiting_approval');
  assert.equal(steward.probe.get(proposed.body.taskId).approval, null);
  const selection = { requestId: proposed.body.id, proposalHash: proposed.body.proposalHash };
  assert.equal((await action('/api/approve', { ...selection, proposalHash: 'wrong' }, session)).status, 400);
  const approved = await action('/api/approve', selection, session);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.approval.owner, 'local-owner');
  const dispatched = await action('/api/dispatch', { ...selection, lostResponse: true }, session);
  assert.equal(dispatched.status, 200); assert.equal(dispatched.body.dispatch, 'unknown');
  const replay = await action('/api/dispatch', { ...selection, lostResponse: false }, session);
  assert.equal(replay.status, 200); assert.equal(replay.body.dispatch, 'unknown');
  const reconciled = await action('/api/reconcile', { requestId: proposed.body.id }, session);
  assert.equal(reconciled.status, 200);
  assert.equal(reconciled.body.result.result, 'tested_draft_pr');
  assert.equal(reconciled.body.execution, 'unobserved');
  assert.equal(steward.probe.controls().active, proposed.body.taskId);
  assert.equal(steward.probe.history(proposed.body.taskId).filter(event => event.kind === 'dispatch_intent').length, 1);
  assert.equal(providerCalls, 0);
  const state = await send('/api/state', { headers: { cookie: session.cookie } });
  assert.equal(state.body.mode, 'synthetic');
  assert.equal(state.body.requests[0].task.result.result, 'tested_draft_pr');
});
