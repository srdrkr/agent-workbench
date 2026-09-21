import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createEveJudge } from '../judge.js';
import { boundedModel } from '../bounded-model.js';
import { startFixture } from '../start-fixture.js';

const root = resolve(import.meta.dirname, '..');
const input = {
  request: 'What is the next useful action?',
  project: { id: 'synthetic', revision: 'r1', objective: 'Choose a priority',
    sources: [{ id: 'brief', exposure: 'model_allowed', content: 'Synthetic context only.' }], codingCandidates: [] },
  commitments: [],
};
const authToken = 'synthetic-local-fixture-token-123';

test('disabled adapter and disclosure policy fail before network', async () => {
  await assert.rejects((await createEveJudge())(input), /JUDGE_DISABLED/);
  const judge = await createEveJudge({ enabled: true, host: 'http://127.0.0.1:1', authToken });
  const hosted = await createEveJudge({ enabled: true, hosted: true, host: 'http://127.0.0.1:1', authToken });
  await assert.rejects(hosted(input), /JUDGE_INPUT_INVALID/);
  const privateInput = structuredClone(input);
  privateInput.project.sources[0].exposure = 'local_only';
  await assert.rejects(judge(privateInput), /JUDGE_CONTEXT_NOT_APPROVED_FOR_MODEL/);
  await assert.rejects(judge({ ...input, commitments: [{ contextRevision: 'older-private-revision' }] }), /JUDGE_CONTEXT_NOT_APPROVED_FOR_MODEL/);
  await assert.rejects(judge({ ...input, request: 'x'.repeat(32_769) }), /JUDGE_INPUT_INVALID/);
});

test('model boundary limits calls and output and sanitizes provider failures', async () => {
  let calls = 0;
  const model = boundedModel({
    async doGenerate(params) {
      calls++;
      assert.equal(params.maxOutputTokens, 2048);
      assert.ok(params.abortSignal instanceof AbortSignal);
      throw new Error('synthetic raw provider response must not escape');
    },
  });
  await assert.rejects(model.doGenerate({}), /^Error: JUDGE_MODEL_FAILED$/);
  await assert.rejects(model.doGenerate({}), /^Error: JUDGE_MODEL_RETRY_BLOCKED$/);
  assert.equal(calls, 1);
});

test('failed or timed-out session creation is one attempt and returns a fixed error', async () => {
  let calls = 0;
  let hang = false;
  const server = createHttpServer((_request, response) => {
    calls++;
    if (!hang) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'synthetic-private-provider-error' }));
    }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const judge = await createEveJudge({ enabled: true, host: `http://127.0.0.1:${server.address().port}`, authToken, timeoutMs: 100 });
    await assert.rejects(judge(input), /^Error: JUDGE_UNAVAILABLE_OR_INVALID$/);
    assert.equal(calls, 1);
    hang = true;
    await assert.rejects(judge(input), /^Error: JUDGE_UNAVAILABLE_OR_INVALID$/);
    assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
});

test('fixture launcher refuses a busy port before creating or changing a credential', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'workbench-eve-busy-'));
  const listener = createServer();
  await new Promise(resolveListen => listener.listen(0, '127.0.0.1', resolveListen));
  try {
    await assert.rejects(startFixture({ runtime: temp, port: listener.address().port }), /FIXTURE_PORT_UNAVAILABLE/);
    await assert.rejects(stat(join(temp, 'eve-key')), error => error.code === 'ENOENT');
  } finally {
    await new Promise(resolveClose => listener.close(resolveClose));
    await rm(temp, { recursive: true, force: true });
  }
});

test('actual Eve runtime returns a structured mock judgment with no external tools', { timeout: 120_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'workbench-eve-fixture-'));
  let child;
  try {
    for (const path of ['agent', 'package.json', 'bounded-model.js', 'eval-ledger.js', 'eval-transport.js', 'rejection-diagnostics.js', 'gateway-request.js', 'hosted', 'shared']) await cp(join(root, path), join(temp, path), { recursive: true });
    await symlink(join(root, 'node_modules'), join(temp, 'node_modules'));
    const port = await new Promise((resolvePort, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
    });
    const host = `http://127.0.0.1:${port}`;
    // No model, provider, GitHub or routine credentials inherited by this child.
    child = spawn(process.execPath, [join(root, 'node_modules/eve/bin/eve.js'), 'dev', '--no-ui', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: temp,
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), EVE_TELEMETRY_DISABLED: '1', EVE_TRACES: 'off', EVE_TRACES_CONTENT: 'off',
        WORKBENCH_EVE_MODE: 'fixture', WORKBENCH_EVE_ACCESS_TOKEN: authToken },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    let ready = false;
    for (let i = 0; i < 180; i++) {
      if (child.exitCode !== null) throw new Error('FIXTURE_SERVER_START_FAILED');
      try { ready = (await fetch(`${host}/eve/v1/health`)).ok; } catch { /* startup only */ }
      if (ready) break;
      await delay(250);
    }
    assert.ok(ready, 'Eve fixture server became healthy');
    const unauthorized = await fetch(`${host}/eve/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'synthetic' }) });
    assert.equal(unauthorized.status, 401);
    const judge = await createEveJudge({ enabled: true, host, authToken });
    assert.deepEqual(await judge(input), {
      kind: 'clarify', candidateId: null, title: 'Confirm the next priority',
      rationale: 'The synthetic fixture needs an owner priority decision.',
      citations: ['brief'], question: 'Which current commitment takes priority?',
    });
    const hosted = await createEveJudge({ enabled: true, hosted: true, host, authToken });
    assert.equal((await hosted({ ...input, hostedRequestId: 'hosted-request' })).kind, 'clarify');
    const reviewer = await createEveJudge({ enabled: true, hosted: true, review: true, host, authToken });
    assert.deepEqual(await reviewer({ ...input, hostedRequestId: 'review-runtime' }), { verdict: 'ready', summary: 'Synthetic patch reviewed.', findings: [] });
    const withCandidate = { ...input, project: { ...input.project,
      codingCandidates: [{ id: 'normalize', title: 'Normalize whitespace', sourceIds: ['brief'] }] } };
    assert.equal((await judge(withCandidate)).kind, 'coding');
    assert.equal((await judge({ ...withCandidate, request: 'Review the blocker' })).kind, 'clarify');
    assert.equal((await judge({ ...withCandidate, request: 'Propose a commitment' })).kind, 'commitment');
    // The fixture itself rejects any tool grant beyond Eve's structured-output
    // envelope. This checks runtime discovery, not only a source-code allowlist.
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ }
      await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), delay(3000)]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
    }
    await rm(temp, { recursive: true, force: true });
  }
});
