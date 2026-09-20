import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Steward } from '../src/steward.js';

const spec = JSON.parse(readFileSync(new URL('../fixtures/task.json', import.meta.url)));
const clone = value => JSON.parse(JSON.stringify(value));
const context = () => ({
  id: 'synthetic-project', name: 'Synthetic project', objective: 'Normalize project slugs.',
  sources: [{ id: 'brief', title: 'Approved brief', revision: 'brief-v1',
    observedAt: '2026-09-17T11:00:00.000Z', expiresAt: '2026-09-18T12:00:00.000Z',
    content: 'The whitespace cases fail. Repair slug.js and preserve the tests.', exposure: 'model_allowed' }],
  codingCandidates: [{ id: 'repair-slug', title: 'Repair slug normalization', sourceIds: ['brief'], spec }],
});
const coding = () => ({ kind: 'coding', candidateId: 'repair-slug', title: 'Repair slug normalization',
  rationale: 'The approved brief identifies failing whitespace cases.', citations: ['brief'], question: null });
const commitment = () => ({ ...coding(), kind: 'commitment', candidateId: null, title: 'Review the repaired slug behavior' });
const input = (requestId = 'request-1', message = 'What should we do next?') => ({ requestId, projectId: 'synthetic-project', message });
const approval = proposal => ({ owner: 'local-owner', proposalHash: proposal.proposalHash });
const accepted = () => new Response(JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'session_SYNTHETIC',
  claude_code_session_url: 'https://claude.ai/code/session_SYNTHETIC' }));

function setup(t, judge = async () => coding(), project = context()) {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-steward-test-'));
  const path = join(dir, 'state.sqlite');
  let now = '2026-09-17T12:00:00.000Z';
  const options = { now: () => now, judge, judgeName: 'deterministic test' };
  const instances = [];
  const open = () => { const instance = new Steward(path, options); instances.push(instance); return instance; };
  const steward = open();
  steward.importProject(project);
  t.after(() => {
    for (const instance of instances) { try { instance.close(); } catch { /* closed to simulate restart */ } }
    rmSync(dir, { recursive: true, force: true });
  });
  return { steward, open, advance: value => { now = value; } };
}

test('owner approval binds the exact proposal and imported project', async t => {
  let modelCalls = 0;
  const { steward } = setup(t, async () => { modelCalls++; return coding(); });
  await assert.rejects(steward.propose({ ...input(), projectId: 'another-project' }), /access denied/);
  assert.equal(modelCalls, 0);
  assert.throws(() => steward.importProject({ ...context(), id: 'another-project' }), /one project/);
  const proposed = await steward.propose(input());
  assert.equal(proposed.status, 'awaiting_approval');
  assert.equal(steward.probe.get(proposed.taskId).approval, null);
  for (const wrong of [{ ...approval(proposed), owner: 'worker' }, { ...approval(proposed), proposalHash: 'different' }]) {
    assert.throws(() => steward.approve(proposed.id, wrong), /owner|match/);
  }
  assert.equal(steward.probe.get(proposed.taskId).approval, null);
  assert.equal(steward.approve(proposed.id, approval(proposed)).status, 'approved');
  assert.equal(steward.probe.get(proposed.taskId).approval.consumed, false);
});

test('model proposals cannot invent citations, coding targets, or extra authority', async t => {
  let output = coding();
  const { steward } = setup(t, async () => clone(output));
  const invalid = [
    { ...coding(), citations: ['invented-source'] },
    { ...coding(), citations: [] },
    { ...coding(), candidateId: 'unapproved-target' },
    { ...coding(), repository: 'another-owner/another-repo' },
    { ...coding(), authority: 'merge without approval' },
    { ...commitment(), candidateId: 'repair-slug' },
    { ...coding(), kind: 'merge' },
  ];
  for (const [index, candidate] of invalid.entries()) {
    output = candidate;
    const result = await steward.propose(input(`invalid-${index}`));
    assert.equal(result.status, 'failed');
    assert.equal(result.failure, 'judgment_unavailable_or_invalid');
    assert.equal(result.proposal, undefined);
    assert.equal(result.taskId, undefined);
  }
  assert.equal(steward.db.prepare('SELECT count(*) AS count FROM tasks').get().count, 0);
});

test('coding proposals must cite every source required by the selected candidate', async t => {
  const project = context();
  project.sources.push({ ...project.sources[0], id: 'test-results', title: 'Test results' });
  project.codingCandidates[0].sourceIds.push('test-results');
  const { steward } = setup(t, async () => coding(), project);
  assert.equal((await steward.propose(input())).status, 'failed');
});

test('import rejects new effect fields and live coding candidates', t => {
  const { steward } = setup(t);
  const revision = steward.project().revision;
  const malicious = context(); malicious.codingCandidates[0].spec = { ...spec, authority: 'merge' };
  assert.throws(() => steward.importProject(malicious), /fields/);
  const live = context(); live.codingCandidates[0].spec = { ...spec, mode: 'live' };
  assert.throws(() => steward.importProject(live), /synthetic/);
  assert.equal(steward.project().revision, revision);
});

test('expired and future context asks for clarification without a model call or approval', async t => {
  let calls = 0;
  const { steward, advance } = setup(t, async () => { calls++; return coding(); });
  for (const [index, instant] of ['2026-09-16T12:00:00.000Z', '2026-09-18T12:00:00.000Z'].entries()) {
    advance(instant);
    const proposed = await steward.propose(input(`stale-${index}`));
    assert.equal(proposed.status, 'needs_context');
    assert.equal(proposed.proposal.kind, 'clarify');
    assert.equal(proposed.taskId, undefined);
    assert.throws(() => steward.approve(proposed.id, approval(proposed)), /Context changed or expired/);
  }
  assert.equal(calls, 0);
});

test('context revision and freshness are rechecked before approval and dispatch', async t => {
  const { steward, advance } = setup(t);
  const proposed = await steward.propose(input());
  const revised = context(); revised.sources[0].revision = 'brief-v2';
  steward.importProject(revised);
  assert.throws(() => steward.approve(proposed.id, approval(proposed)), /Context changed/);
  const current = await steward.propose(input('current'));
  steward.approve(current.id, approval(current));
  advance('2026-09-18T12:00:00.000Z');
  let calls = 0;
  await assert.rejects(steward.dispatch(current.id, approval(current), async () => { calls++; return accepted(); }), /Context changed or expired/);
  assert.equal(calls, 0);
  assert.equal(steward.probe.get(current.taskId).dispatch, 'not_sent');
});

test('historical context and cited content survive replacement and restart without preserving stale authority', async t => {
  const { steward, open } = setup(t);
  const originalProject = steward.project();
  const proposed = await steward.propose(input());
  steward.approve(proposed.id, approval(proposed));
  const revised = context();
  revised.sources[0].revision = 'brief-v2';
  revised.sources[0].content = 'The whitespace fix is complete. Evaluate a different priority.';
  steward.importProject(revised);
  steward.close();

  const restarted = open();
  const historical = restarted.request(proposed.id);
  assert.deepEqual(historical.contextSnapshot, originalProject);
  assert.equal(historical.contextSnapshot.sources.find(source => source.id === historical.proposal.citations[0]).content,
    originalProject.sources[0].content);
  assert.equal(restarted.project().sources[0].content, revised.sources[0].content);
  assert.notEqual(historical.contextRevision, restarted.project().revision);
  assert.throws(() => restarted.approve(historical.id, approval(historical)), /Context changed/);
  assert.equal(restarted.probe.get(historical.taskId).dispatch, 'not_sent');
});

test('omitted synthetic transport rejects before approval or dispatch intent without using global fetch', async t => {
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { providerCalls++; throw new Error('Unexpected external provider call'); });
  const { steward } = setup(t);
  const proposed = await steward.propose(input());
  const history = steward.probe.history(proposed.taskId);
  await assert.rejects(steward.dispatch(proposed.id, approval(proposed)), /Explicit synthetic transport required/);
  assert.equal(providerCalls, 0);
  assert.deepEqual(steward.request(proposed.id), proposed);
  assert.deepEqual(steward.probe.history(proposed.taskId), history);
  assert.equal(steward.probe.get(proposed.taskId).approval, null);
  assert.equal(steward.probe.get(proposed.taskId).dispatch, 'not_sent');
  assert.equal(steward.probe.controls().active, null);
});

test('coding authorization expires after fifteen minutes without a fire', async t => {
  const { steward, advance } = setup(t);
  const proposed = await steward.propose(input());
  steward.approve(proposed.id, approval(proposed));
  advance('2026-09-17T12:15:00.000Z');
  let calls = 0;
  await assert.rejects(steward.dispatch(proposed.id, approval(proposed), async () => { calls++; return accepted(); }), /Approval expired/);
  assert.equal(calls, 0);
});

test('a new approved proposal can renew an expired, never-used candidate authorization', async t => {
  const { steward, advance } = setup(t);
  const original = await steward.propose(input('original'));
  steward.approve(original.id, approval(original));
  advance('2026-09-17T12:16:00.000Z');
  const refreshed = await steward.propose(input('refreshed'));
  assert.equal(refreshed.taskId, original.taskId);
  let calls = 0;
  const result = await steward.dispatch(refreshed.id, approval(refreshed), async () => { calls++; return accepted(); });
  assert.equal(result.dispatch, 'accepted');
  assert.equal(calls, 1);
});

test('a suggested commitment becomes durable only on matching owner approval', async t => {
  const { steward, open } = setup(t, async () => commitment());
  const proposed = await steward.propose(input());
  assert.deepEqual(steward.commitments(), []);
  assert.throws(() => steward.approve(proposed.id, { ...approval(proposed), owner: 'model' }), /owner/);
  assert.deepEqual(steward.commitments(), []);
  steward.approve(proposed.id, approval(proposed));
  steward.approve(proposed.id, approval(proposed));
  assert.equal(steward.commitments().length, 1);
  steward.close();
  const restarted = open();
  assert.equal(restarted.commitments()[0].id, proposed.id);
  assert.deepEqual(restarted.commitments()[0].citations, ['brief']);
  let calls = 0;
  await assert.rejects(restarted.dispatch(proposed.id, approval(proposed), async () => { calls++; return accepted(); }), /no coding handoff/);
  assert.equal(calls, 0);
});

test('duplicate conversational input returns persisted judgment; changed input needs a new ID', async t => {
  let calls = 0;
  const { steward, open } = setup(t, async () => { calls++; return coding(); });
  const first = await steward.propose(input());
  assert.deepEqual(await steward.propose(input()), first);
  await assert.rejects(steward.propose(input('request-1', 'Change the objective')), /reused with different input/);
  steward.close();
  assert.deepEqual(await open().propose(input()), first);
  assert.equal(calls, 1);
});

test('in-flight and interrupted model calls are held across connections without hidden replay', async t => {
  let calls = 0; let finish;
  const { steward, open } = setup(t, () => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const pending = steward.propose(input());
  assert.equal((await steward.propose(input())).status, 'thinking');
  const other = open();
  assert.equal((await other.propose(input())).status, 'thinking');
  assert.equal(calls, 1);
  finish(coding()); await pending;
  assert.equal((await other.propose(input())).status, 'awaiting_approval');

  // Simulate process loss with a durable thinking record and no resolved provider promise.
  const interrupted = other.propose(input('interrupted'));
  void interrupted;
  other.close();
  const restarted = open();
  assert.equal((await restarted.propose(input('interrupted'))).status, 'thinking');
  assert.equal(calls, 2);
});

test('separate requests for one coding candidate share one task and one fire intent', async t => {
  const { steward, advance } = setup(t);
  const first = await steward.propose(input('first'));
  const second = await steward.propose(input('second', 'Please tackle the slug next.'));
  assert.equal(first.taskId, second.taskId);
  let calls = 0;
  const transport = async () => { calls++; return accepted(); };
  await steward.dispatch(first.id, approval(first), transport);
  advance('2026-09-17T12:16:00.000Z');
  await steward.dispatch(second.id, approval(second), transport);
  assert.equal(calls, 1);
  assert.equal(steward.probe.history(first.taskId).filter(event => event.kind === 'dispatch_intent').length, 1);
});

test('raw model failures are sanitized and a repeated request never reruns the failed call', async t => {
  const sentinel = 'private-model-error-sentinel';
  let calls = 0;
  const { steward } = setup(t, async () => { calls++; throw new Error(sentinel); });
  const failed = await steward.propose(input());
  assert.equal(failed.failure, 'judgment_unavailable_or_invalid');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(await steward.propose(input()), failed);
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(steward.view()).includes(sentinel));
  const events = steward.db.prepare('SELECT data FROM events').all();
  assert.ok(!JSON.stringify(events).includes(sentinel));
});

test('unknown dispatch holds admission through restart and rejects competing work without retry', async t => {
  const project = context();
  project.codingCandidates.push({ ...clone(project.codingCandidates[0]), id: 'another-fix' });
  let selected = 'repair-slug';
  const { steward, open } = setup(t, async () => ({ ...coding(), candidateId: selected }), project);
  const first = await steward.propose(input('first'));
  let calls = 0;
  const transport = async () => { calls++; throw new Error('private-transport-error-sentinel'); };
  const unknown = await steward.dispatch(first.id, approval(first), transport);
  assert.equal(unknown.dispatch, 'unknown');
  steward.close();
  const restarted = open();
  await restarted.dispatch(first.id, approval(first), transport);
  assert.equal(calls, 1);
  assert.equal(restarted.probe.controls().active, first.taskId);
  selected = 'another-fix';
  const second = await restarted.propose(input('second'));
  await assert.rejects(restarted.dispatch(second.id, approval(second), transport), /admission is blocked/);
  assert.equal(calls, 1);
  assert.equal(restarted.probe.get(second.taskId).dispatch, 'not_sent');
  assert.ok(!JSON.stringify(restarted.view()).includes('private-transport-error-sentinel'));
});
