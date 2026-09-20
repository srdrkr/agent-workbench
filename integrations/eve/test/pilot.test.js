import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TestPool } from './pg-fixture.js';
import { HostedStore, stateSchema } from '../hosted/store.js';
import { HostedSteward, initialState } from '../hosted/steward.js';
import { progressSource } from '../hosted/pilot.js';
import { judgmentProject } from '../hosted/continuation.js';
import { HostedCoding } from '../hosted/coding.js';
import { ProgressMonitor, monitorAuthorized } from '../hosted/monitor.js';
const project = JSON.parse(await readFile(new URL('../../../fixtures/steward-project.json', import.meta.url)));
async function fixture(t) {
  const pool = new TestPool(); t.after(() => pool.end()); await pool.query(stateSchema);
  const store = new HostedStore(pool, { ownerId: 'owner@example.com', projectId: project.id });
  await store.initialize(initialState(project, { model: 'anthropic/claude-opus-5', budgetMicros: 1000000 }));
  let clock = '2026-09-19T12:00:00.000Z'; const now = () => clock;
  const steward = new HostedSteward(store, async () => assert.fail('No model call expected'), { now });
  return { store, steward, now, advance: value => { clock = value; } };
}
async function pilot(f) { const r = await f.steward.reviewPilot({ budgetMicros: 1000000, maxProviderAttempts: 50 }); await f.steward.approvePilot({ reviewHash: r.reviewHash }); }

test('pilot approval retains reservations and attempts; stale approval cannot restore old limits', async t => {
  const f = await fixture(t);
  await f.store.change(s => { s.reservedMicros = 843790; s.requests.old = { id: 'old', status: 'approved', createdAt: f.now(), provider: { reservedMicros: 843790 } }; });
  const r = await f.steward.reviewPilot({ budgetMicros: 1000000, maxProviderAttempts: 50 });
  await f.steward.approvePilot({ reviewHash: r.reviewHash });
  await f.steward.approvePilot({ reviewHash: r.reviewHash });
  assert.equal((await f.store.read()).reservedMicros, 843790);
  assert.equal((await f.steward.view()).providerAttempts, 1);
  const newer = await f.steward.reviewPilot({ budgetMicros: 2000000, maxProviderAttempts: 60 });
  await f.steward.approvePilot({ reviewHash: newer.reviewHash });
  await assert.rejects(f.steward.approvePilot({ reviewHash: r.reviewHash }), /STALE/);
  await assert.rejects(f.steward.reviewPilot({ budgetMicros: 1, maxProviderAttempts: 50 }), /INVALID/);
});

test('pilot allowance cannot clear a held result or resume paused work', async t => {
  const f = await fixture(t); const r = await f.steward.reviewPilot({ budgetMicros: 1000000, maxProviderAttempts: 50 });
  await f.store.change(s => { s.requests.held = { status: 'held' }; s.paused = true; });
  await assert.rejects(f.steward.approvePilot({ reviewHash: r.reviewHash }), /UNRESOLVED/);
  await assert.rejects(f.steward.resume(), /UNRESOLVED/);
  await f.store.change(s => { delete s.requests.held; });
  await f.steward.approvePilot({ reviewHash: r.reviewHash }); assert.equal((await f.store.read()).paused, true);
});

test('durable notes and owner-reported completion survive brief revision; other projects remain isolated', async t => {
  const f = await fixture(t); await pilot(f); const first = await f.store.read();
  await f.steward.saveNote({ text: 'Priority: useful follow-through.', expectedContextRevision: first.project.revision });
  await f.store.change(s => { s.commitments.review = { id: 'review', title: 'Review PR', contextRevision: s.project.revision, approvedAt: f.now() }; });
  await f.steward.completeCommitment({ commitmentId: 'review', expectedContextRevision: first.project.revision });
  const next = { ...structuredClone(project), objective: 'Revised objective' };
  let preview = await f.steward.previewContext(next); await f.steward.applyContext({ previewId: preview.id, expectedRevision: preview.expectedRevision });
  let state = await f.store.read();
  const source = progressSource(state, f.now()); assert.match(source.content, /owner_reported_complete/); assert.match(source.content, /useful follow-through/);
  preview = await f.steward.previewContext({ ...next, id: 'other-project' }); await f.steward.applyContext({ previewId: preview.id, expectedRevision: preview.expectedRevision });
  state = await f.store.read(); assert.doesNotMatch(progressSource(state, f.now()).content, /useful follow-through|Review PR/);
  assert.equal(state.memory.notes.length, 1);
  await assert.rejects(f.steward.completeCommitment({ commitmentId: 'review', expectedContextRevision: state.project.revision }), /MISMATCH/);
});

test('pilot retires single-use continuation admission without destroying its historical snapshot', async t => {
  const f = await fixture(t);
  await f.store.change(s => { s.continuation = { contextRevision: 'earlier', model: s.model, source: { expiresAt: '2000-01-01' } }; });
  const before = await f.store.read(); assert.throws(() => judgmentProject(before, f.now()), /CONTEXT_CHANGED/);
  await pilot(f); const s = await f.store.read();
  assert.ok(judgmentProject(s, f.now()).sources.some(x => x.id === 'project-progress'));
  assert.equal(s.continuation.contextRevision, 'earlier');
});

test('requests sort chronologically rather than JSONB key ordering', async t => {
  const f = await fixture(t);
  await f.store.change(s => { s.requests = { z: { id: 'z', createdAt: '2026-09-18T00:00:00Z', status: 'approved' }, a: { id: 'a', createdAt: '2026-09-19T00:00:00Z', status: 'approved' } }; });
  assert.deepEqual((await f.steward.view()).requests.map(r => r.id), ['a','z']);
});

test('repeatable assignment fixes connection authority and dispatches only after exact approval once', async t => {
  const f = await fixture(t); await pilot(f);
  const spec = { ...project.codingCandidates[0].spec, mode: 'live' }; let fires = 0;
  const coding = new HostedCoding(f.store, { now: f.now, config: { spec, repeatable: true, verifiedUntil: '2026-09-20T12:00:00Z', token: 'test-secret' },
    read: async path => path.includes('/commits/') ? { sha: 'a'.repeat(40) } : { full_name: spec.repository, private: false, default_branch: spec.baseBranch },
    send: async () => { fires++; return { outcome: 'unknown' }; } });
  const draft = { objective: 'Improve controls', acceptance: 'Clear action and passing checks', allowedPaths: ['src/ui.js'], expectedContextRevision: (await f.store.read()).project.revision, repository: 'attacker/repo', routineId: 'trig_ATTACK' };
  const review = await coding.prepare(draft); assert.equal(fires, 0);
  assert.equal(review.spec.repository, spec.repository); assert.equal(review.spec.routineId, spec.routineId); assert.deepEqual(review.spec.requiredChecks, spec.requiredChecks); assert.equal(review.spec.baseSha, 'a'.repeat(40));
  await assert.rejects(coding.approveAndDispatch({ ...review, reviewHash: 'tampered' }), /MISMATCH/);
  await coding.approveAndDispatch(review); await coding.approveAndDispatch(review); assert.equal(fires, 1);
  await assert.rejects(coding.prepare(draft), /PAUSED/);
});

test('monitor is model-free, debounces concurrent calls and never repeats uncertain notification delivery', async t => {
  const f = await fixture(t); await pilot(f); let checks = 0; let messages = 0;
  const job = { id: 'job', spec: { objective: 'Improve UI' }, dispatch: 'unknown', dispatchStartedAt: f.now(), execution: 'unobserved' };
  await f.store.change(s => { s.coding = { active: 'job', jobs: { job }, paused: false }; });
  const monitor = new ProgressMonitor({ store: f.store, now: f.now, coding: { reconcile: async () => { checks++; return f.store.change(s => { s.coding.jobs.job.result = { result: 'tested_draft_pr', headSha: 'a'.repeat(40), observedAt: f.now() }; return s.coding.jobs.job; }); } }, notify: async () => { messages++; return false; } });
  await Promise.all([monitor.run(), monitor.run()]); assert.equal(checks, 1); assert.equal(messages, 1);
  f.advance('2026-09-19T12:16:00Z'); await monitor.run(); assert.equal(checks, 2); assert.equal(messages, 1);
  const state = await f.store.read(); assert.equal(state.coding.active, 'job'); assert.equal(state.coding.jobs.job.execution, 'unobserved'); assert.equal(state.reservedMicros, 0);
  assert.equal(Object.values(state.monitor.notifications)[0].status, 'delivery_unknown');
});

test('monitor endpoint secret is mandatory and only authorizes a POST', () => {
  const secret = 'x'.repeat(40);
  assert.equal(monitorAuthorized(new Request('https://example.test', { method: 'POST', headers: { authorization: `Bearer ${secret}` } }), secret), true);
  assert.equal(monitorAuthorized(new Request('https://example.test', { headers: { authorization: `Bearer ${secret}` } }), secret), false);
  assert.equal(monitorAuthorized(new Request('https://example.test', { method: 'POST' }), secret), false);
  assert.equal(monitorAuthorized(new Request('https://example.test', { method: 'POST' }), undefined), false);
});

test('large valid memory is compacted at serialization time and active commitments stay ahead of completed ones', async t => {
  const f = await fixture(t); await pilot(f);
  await f.store.change(s => {
    s.memory = { notes: Array.from({ length: 25 }, (_, i) => ({ text: i === 0 ? '\u0001'.repeat(700) : '\\"'.repeat(500), kind: i === 0 ? 'priority' : 'note', projectId: s.project.id, at: f.now() })) };
    s.commitments = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`c${i}`, { title: 'Old done', projectId: s.project.id, approvedAt: f.now(), completedAt: f.now() }]));
    s.commitments.active = { title: 'Still unresolved', projectId: s.project.id, approvedAt: f.now() };
  });
  const source = progressSource(await f.store.read(), f.now()); assert.ok(source.content.length <= 4000);
  assert.ok(JSON.parse(source.content).priority); assert.match(source.content, /Still unresolved/);
});

test('monitor recovers a persisted merged result that has no notification intent', async t => {
  const f = await fixture(t); await pilot(f); let sends = 0;
  await f.store.change(s => { s.coding = { jobs: { job: { id: 'job', dispatch: 'accepted', dispatchStartedAt: f.now(), result: { result: 'merged_pr', mergeCommitSha: 'b'.repeat(40) } } } }; });
  const monitor = new ProgressMonitor({ store: f.store, now: f.now, coding: { reconcile: () => assert.fail('Merged job should not be polled') }, notify: async () => { sends++; return true; } });
  await monitor.run(); f.advance('2026-09-19T12:20:00Z'); await monitor.run(); assert.equal(sends, 1);
});
