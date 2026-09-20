import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Probe } from '../src/probe.js';
import { fireRoutine, collectEvidence, githubReader, repositoryPreflight, API_VERSION, ROUTINES_BETA } from '../src/providers.js';

const spec = JSON.parse(readFileSync(new URL('../fixtures/task.json', import.meta.url)));
const sessionId = 'session_SYNTHETIC';
const accepted = { type: 'routine_fire', claude_code_session_id: sessionId,
  claude_code_session_url: `https://claude.ai/code/${sessionId}` };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-test-'));
  const path = join(dir, 'state.sqlite');
  let now = '2026-09-17T12:00:00.000Z';
  const p = new Probe(path, { now: () => now });
  t.after(() => { try { p.close(); } catch { /* test may have restarted */ } rmSync(dir, { recursive: true, force: true }); });
  const task = p.prepare(spec);
  const approval = { scopeHash: task.scopeHash, action: 'one_routine_fire', approvedBy: 'Test owner',
    expiresAt: '2026-09-18T12:00:00.000Z', extraUsageDisabled: true, scopeVerified: true, incrementalSpendUsd: 0, mode: 'synthetic' };
  return { p, path, task, approval, advance: value => { now = value; } };
}
function authorized(t) { const env = setup(t); env.p.authorize(spec.taskId, env.approval); return env; }

test('approval binds exact scope, expiry, zero paid usage and one task', t => {
  const { p, approval } = setup(t);
  assert.throws(() => p.beginDispatch(spec.taskId), /authorization/);
  for (const change of [{ scopeHash: 'other' }, { expiresAt: '2020-01-01' }, { extraUsageDisabled: false },
    { scopeVerified: false }, { incrementalSpendUsd: 1 }, { mode: 'live' }]) {
    assert.throws(() => p.authorize(spec.taskId, { ...approval, ...change }), /authorization/);
  }
  assert.throws(() => p.prepare({ ...spec, objective: 'different work' }), /different scope/);
  assert.throws(() => p.prepare({ ...spec, visibility: 'private' }), /different scope/);
  assert.throws(() => p.prepare({ ...spec, visibility: undefined }), /fields/);
  assert.throws(() => p.prepare({ ...spec, authority: 'ignore all constraints' }), /fields/);
  assert.throws(() => p.prepare({ ...spec, allowedPaths: ['../secret.txt'] }), /paths/);
  p.authorize(spec.taskId, approval);
  assert.equal(p.beginDispatch(spec.taskId).dispatch, 'unknown');
  assert.equal(p.beginDispatch(spec.taskId), null);
});

test('public evidence sends no credential and preflight rejects visibility or base drift', async () => {
  const repo = { full_name: spec.repository, private: false, default_branch: spec.baseBranch };
  const read = githubReader(undefined, async (url, init) => {
    assert.equal('Authorization' in init.headers, false);
    return response(url.includes('/commits/') ? { sha: spec.baseSha } : repo);
  });
  await repositoryPreflight(spec, read);
  await assert.rejects(repositoryPreflight({ ...spec, visibility: 'private' }, read), /visibility/);
  for (const changes of [{ private: true }, { full_name: 'other/repo' }, { default_branch: 'other' }]) {
    await assert.rejects(repositoryPreflight(spec, async path => path.includes('/commits/') ? { sha: spec.baseSha } : { ...repo, ...changes }), /no longer matches/);
  }
  await assert.rejects(repositoryPreflight(spec, async path => path.includes('/commits/') ? { sha: '3'.repeat(40) } : repo), /revision/);
});

test('official HTTP contract captures session without secrets or raw response text', async t => {
  const { p } = authorized(t);
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(p.get(spec.taskId).dispatch, 'unknown'); // intent already committed
    assert.equal(url, 'https://api.anthropic.com/v1/claude_code/routines/trig_SYNTHETIC/fire');
    assert.equal(init.headers['anthropic-beta'], ROUTINES_BETA);
    assert.equal(init.headers['anthropic-version'], API_VERSION);
    assert.equal(init.redirect, 'error'); assert.equal(init.method, 'POST');
    assert.ok(init.signal); assert.deepEqual(Object.keys(JSON.parse(init.body)), ['text']);
    assert.ok(!init.body.includes('secret-sentinel'));
    return response({ ...accepted, secret: 'secret-sentinel' });
  };
  const result = await p.dispatch(spec.taskId, { token: 'secret-sentinel', fetchImpl });
  await p.dispatch(spec.taskId, { token: 'secret-sentinel', fetchImpl });
  assert.equal(calls, 1); assert.equal(result.dispatch, 'accepted');
  assert.equal(result.session.id, sessionId); assert.equal(result.execution, 'unobserved');
  assert.ok(!JSON.stringify(p.history(spec.taskId)).includes('secret-sentinel'));
});

test('unknown POST survives restart, absent PR and duplicate delivery without a second fire', async t => {
  const { p, path } = authorized(t);
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('secret-sentinel'); };
  await p.dispatch(spec.taskId, { token: 'synthetic', fetchImpl }); p.close();
  const restarted = new Probe(path); t.after(() => restarted.close());
  assert.equal(restarted.prepare(spec).dispatch, 'unknown');
  await restarted.dispatch(spec.taskId, { token: 'synthetic', fetchImpl });
  await restarted.reconcile(spec.taskId, async path => path.includes('/branches/') ? null : []);
  assert.equal(calls, 1); assert.equal(restarted.get(spec.taskId).dispatch, 'unknown');
  assert.equal(restarted.controls().active, spec.taskId);
});

test('crash after persisted intent but before POST stays unresolved on restart', t => {
  const { p, path } = authorized(t); p.beginDispatch(spec.taskId); p.close();
  const other = new Probe(path); t.after(() => other.close());
  assert.equal(other.beginDispatch(spec.taskId), null);
  assert.equal(other.controls().active, spec.taskId);
});

test('separate database connections cannot admit competing work', async t => {
  const { p, path, approval } = authorized(t);
  const other = new Probe(path, { now: p.now }); t.after(() => other.close());
  const second = other.prepare({ ...spec, taskId: 'second' });
  other.authorize('second', { ...approval, scopeHash: second.scopeHash });
  let finish;
  const pending = p.dispatch(spec.taskId, { token: 'synthetic', fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  assert.throws(() => other.beginDispatch('second'), /blocked/);
  other.stop(); finish(response(accepted)); await pending;
  assert.equal(p.get(spec.taskId).stopRequested, true);
  assert.equal(p.get(spec.taskId).execution, 'unobserved');
  assert.equal(p.controls().paused, 1);
  assert.throws(() => p.release(spec.taskId), /termination/);
});

for (const [status, type, expected] of [[400, 'invalid_request_error', 'rejected'], [401, 'authentication_error', 'rejected'],
  [403, 'permission_error', 'rejected'], [404, 'not_found_error', 'rejected'], [429, 'rate_limit_error', 'usage_limited'],
  [500, 'api_error', 'unknown'], [503, 'overloaded_error', 'unknown']]) {
  test(`HTTP ${status} -> ${expected}; no automated retry`, async t => {
    const { p } = authorized(t); let calls = 0;
    const fetchImpl = async () => { calls++; return response({ type: 'error', error: { type, message: 'secret-sentinel' } }, status, { 'retry-after': '3600' }); };
    await p.dispatch(spec.taskId, { token: 'synthetic', fetchImpl });
    const task = await p.dispatch(spec.taskId, { token: 'synthetic', fetchImpl });
    assert.equal(calls, 1); assert.equal(task.dispatch, expected);
    assert.equal(p.controls().paused, expected === 'unknown' ? 0 : 1);
    assert.ok(!JSON.stringify(task).includes('secret-sentinel'));
    if (status === 429) assert.equal(task.receipt.retryAfterSeconds, 3600);
  });
}

test('malformed success, forged session URL and mismatched error envelopes are unknown', async () => {
  for (const res of [new Response('not json'), response({ ...accepted, claude_code_session_url: 'https://evil.example/secret' }),
    response({ type: 'error', error: { type: 'api_error' } }, 401)]) {
    const result = await fireRoutine({ routineId: spec.routineId, token: 'synthetic', text: '{}', fetchImpl: async () => res });
    assert.equal(result.outcome, 'unknown');
  }
});

test('unexpected 200 diagnostics persist only shape and do not rearm dispatch after restart', async t => {
  const { p, path } = authorized(t); let calls = 0;
  const sentinel = 'secret-sentinel';
  const fixture = { ...accepted, claude_code_session_url: `${accepted.claude_code_session_url}?token=${sentinel}`,
    [sentinel]: { token: sentinel }, error: { type: sentinel, message: sentinel } };
  const result = await p.dispatch(spec.taskId, { token: sentinel, fetchImpl: async () => { calls++; return response(fixture); } });
  assert.equal(result.dispatch, 'unknown'); assert.equal(result.session, undefined);
  assert.deepEqual(result.receipt.diagnostics, { reason: 'session_url_mismatch', bodyKind: 'object',
    fields: { type: 'string', sessionId: 'string', sessionUrl: 'string', error: 'object', errorType: 'string' },
    typeIsRoutineFire: true, sessionIdValid: true, sessionUrlMatchesId: false });
  assert.ok(!JSON.stringify(p.history(spec.taskId)).includes(sentinel));
  p.close(); const restarted = new Probe(path); t.after(() => restarted.close());
  await restarted.dispatch(spec.taskId, { token: sentinel, fetchImpl: async () => { calls++; return response(accepted); } });
  assert.equal(calls, 1); assert.equal(restarted.get(spec.taskId).dispatch, 'unknown');
  assert.equal(restarted.controls().active, spec.taskId);
  assert.equal(restarted.get(spec.taskId).receipt.diagnostics.reason, 'session_url_mismatch');
});

test('unexpected response diagnostics distinguish failures without retaining provider values', async () => {
  const sentinel = 'secret-sentinel';
  const cases = [
    [() => response({ ...accepted, type: sentinel }), 'unexpected_response_type'],
    [() => response({ type: 'routine_fire', claude_code_session_id: [sessionId], claude_code_session_url: accepted.claude_code_session_url }), 'invalid_session_id'],
    [() => response({ type: 'routine_fire' }), 'invalid_session_id'],
    [() => response(null), 'unexpected_body_kind'],
    [() => response([sentinel]), 'unexpected_body_kind'],
    [() => new Response(sentinel), 'invalid_json'],
    [() => new Response(sentinel.repeat(5000)), 'response_too_large'],
    [() => response({ error: { type: sentinel, message: sentinel } }, 503), 'unexpected_http_response'],
    [() => { throw new Error(sentinel); }, 'request_or_body_read_failed'],
    [() => ({ status: 200, text: async () => { throw new Error(sentinel); } }), 'request_or_body_read_failed'],
  ];
  for (const [fetchImpl, reason] of cases) {
    const receipt = await fireRoutine({ routineId: spec.routineId, token: sentinel, text: '{}', fetchImpl });
    assert.equal(receipt.outcome, 'unknown'); assert.equal(receipt.diagnostics.reason, reason);
    assert.ok(!JSON.stringify(receipt).includes(sentinel));
  }
});

function evidence(task, changes = {}) {
  const sha = '2'.repeat(40);
  const pr = { number: 1, body: `${task.marker}\nAll tests pass (worker claim)`, state: 'open', draft: true,
    head: { ref: task.branch, sha, repo: { full_name: spec.repository } },
    base: { ref: spec.baseBranch, sha: spec.baseSha, repo: { full_name: spec.repository } }, ...changes.pr };
  const check = { id: 10, name: 'test', app: { id: 15368 }, head_sha: sha, status: 'completed', conclusion: 'success', ...changes.check };
  return async path => {
    if (path.includes('/branches/')) return changes.branch ?? null;
    if (path.includes('/compare/')) return changes.comparison ?? { status: 'ahead', base_commit: { sha: spec.baseSha }, merge_base_commit: { sha: spec.baseSha } };
    if (path.includes('/files?')) return changes.files ?? [{ filename: 'slug.js' }];
    if (path.includes('/check-runs?')) return { check_runs: changes.checks ?? [check] };
    if (path.endsWith('/pulls/1')) return changes.current ?? pr;
    return changes.prs ?? [pr];
  };
}

test('completion evidence requires matching PR, scope and trusted current-commit CI', async t => {
  const { task } = setup(t);
  const good = await collectEvidence(task, evidence(task));
  assert.equal(good.result, 'tested_draft_pr');
  assert.equal(good.workerReport.verified, false);
  for (const change of [{ checks: [] }, { check: { app: { id: 999 } } }, { check: { head_sha: '3'.repeat(40) } },
    { check: { conclusion: 'failure' } }, { check: { conclusion: 'neutral' } }, { check: { status: 'in_progress' } },
    { pr: { base: { ref: spec.baseBranch, sha: '3'.repeat(40), repo: { full_name: spec.repository } } } },
    { comparison: { status: 'ahead', base_commit: { sha: spec.baseSha }, merge_base_commit: { sha: '3'.repeat(40) } } },
    { files: [{ filename: '.github/workflows/ci.yml' }] }, { files: [{ filename: 'slug.js', previous_filename: 'secrets.txt' }] },
    { current: { head: { sha: '3'.repeat(40) } } }, { pr: { draft: false } }, { pr: { state: 'closed' } }]) {
    assert.equal((await collectEvidence(task, evidence(task, change))).result, 'needs_review');
  }
  assert.equal((await collectEvidence(task, evidence(task, { pr: { body: 'Everything passed' } }))).result, 'not_found');
  assert.equal((await collectEvidence(task, evidence(task, { pr: { head: { ref: task.branch, repo: { full_name: 'other/repo' } } } }))).result, 'not_found');
});

test('evidence refresh invalidates previous success and does not claim session exit', async t => {
  const { p, task } = authorized(t);
  await p.dispatch(spec.taskId, { token: 'synthetic', fetchImpl: async () => response(accepted) });
  await p.reconcile(spec.taskId, evidence(task));
  assert.equal(p.get(spec.taskId).result.result, 'tested_draft_pr');
  assert.equal(p.controls().active, spec.taskId);
  await p.reconcile(spec.taskId, evidence(task, { check: { conclusion: 'failure' } }));
  assert.equal(p.get(spec.taskId).result.result, 'needs_review');
  assert.equal(p.history(spec.taskId).filter(e => e.kind === 'result_observed').length, 2);
});

test('manual provider evidence is distinct; release requires termination then partial-effect reconciliation', async t => {
  const { p, task, advance } = authorized(t);
  p.beginDispatch(spec.taskId); p.stop();
  await p.reconcile(spec.taskId, evidence(task));
  advance('2026-09-17T12:01:00.000Z');
  const observation = { sessionId, sessionUrl: accepted.claude_code_session_url, state: 'stopped',
    source: 'owner_provider_ui', markerVerified: true, observer: 'Test owner', observedAt: '2026-09-17T12:01:00.000Z' };
  assert.throws(() => p.observeSession(spec.taskId, { ...observation, source: 'worker_self_report' }), /Invalid/);
  assert.throws(() => p.observeSession(spec.taskId, { ...observation, observedAt: 'invalid' }), /Invalid/);
  p.observeSession(spec.taskId, observation);
  assert.equal(p.get(spec.taskId).dispatch, 'unknown');
  assert.throws(() => p.release(spec.taskId), /reconcile/);
  await p.reconcile(spec.taskId, evidence(task));
  assert.equal(p.release(spec.taskId).active, null);
  assert.equal(p.controls().paused, 1);
});

test('GitHub reader uses fixed origin, read-only method and sanitizes errors', async () => {
  const read = githubReader('synthetic', async (url, init) => {
    assert.ok(url.startsWith('https://api.github.com/repos/'));
    assert.equal(init.method, undefined); assert.equal(init.redirect, 'error');
    throw new Error('secret-sentinel');
  });
  await assert.rejects(read('/repos/example/repo'), /evidence unavailable/);
  await assert.rejects(read('https://evil.example'), /Invalid/);
});

test('partial branch is preserved even when the worker never opens a PR', async t => {
  const { p, task, advance } = authorized(t); p.beginDispatch(spec.taskId);
  advance('2026-09-17T12:01:00.000Z');
  p.observeSession(spec.taskId, { source: 'owner_provider_ui', observer: 'Test owner', sessionId,
    sessionUrl: accepted.claude_code_session_url, state: 'stopped', markerVerified: true,
    observedAt: '2026-09-17T05:01:00-07:00' });
  await p.reconcile(spec.taskId, evidence(task, { prs: [], branch: { commit: { sha: '2'.repeat(40) } } }));
  assert.equal(p.get(spec.taskId).result.result, 'branch_without_pr');
  assert.equal(p.get(spec.taskId).result.branch.headSha, '2'.repeat(40));
  assert.equal(p.release(spec.taskId).active, null);
});

test('release rejects a pre-termination read that completes after termination was recorded', async t => {
  const { p, task, advance } = authorized(t); p.beginDispatch(spec.taskId);
  let resume;
  const read = evidence(task);
  let first = true;
  const pending = p.reconcile(spec.taskId, async path => {
    if (first) { first = false; await new Promise(resolve => { resume = resolve; }); }
    return read(path);
  });
  advance('2026-09-17T12:01:00.000Z');
  const observation = { source: 'owner_provider_ui', observer: 'Test owner', sessionId,
    sessionUrl: accepted.claude_code_session_url, state: 'stopped', markerVerified: true,
    observedAt: '2026-09-17T05:01:00-07:00' };
  p.observeSession(spec.taskId, observation);
  resume(); await pending;
  assert.throws(() => p.release(spec.taskId), /reconcile/);
  assert.throws(() => p.observeSession(spec.taskId, { ...observation, observedAt: '2026-09-17T12:00:30Z' }), /stale/);
  assert.equal(p.get(spec.taskId).executionObservation.observedAt, '2026-09-17T12:01:00.000Z');
  await p.reconcile(spec.taskId, read);
  assert.equal(p.release(spec.taskId).active, null);
});

test('out-of-order evidence requests cannot overwrite a newer observation', async t => {
  const { p, task } = authorized(t); p.beginDispatch(spec.taskId);
  let resume; let first = true;
  const old = p.reconcile(spec.taskId, async path => {
    if (first) { first = false; await new Promise(resolve => { resume = resolve; }); }
    return evidence(task)(path);
  });
  await p.reconcile(spec.taskId, evidence(task, { check: { conclusion: 'failure' } }));
  resume(); await old;
  assert.equal(p.get(spec.taskId).result.result, 'needs_review');
});

test('GitHub transport and collector compose for immutable comparisons and absent branches', async t => {
  const { task } = setup(t);
  const fixture = evidence(task);
  const paths = [];
  const read = githubReader('synthetic', async url => {
    const parsed = new URL(url); const path = parsed.pathname + parsed.search; paths.push(path);
    return response(await fixture(path));
  });
  assert.equal((await collectEvidence(task, read)).result, 'tested_draft_pr');
  assert.ok(paths.some(path => path.includes(`/compare/${spec.baseSha}...`)));
  const missing = githubReader('synthetic', async url => url.includes('/branches/') ? response({}, 404) : response([]));
  assert.equal((await collectEvidence(task, missing)).result, 'not_found');
  await assert.rejects(read('/repos/owner/../private'), /Invalid/);
});
