import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TestPool } from './pg-fixture.js';
import { HostedStore, stateSchema } from '../hosted/store.js';
import { HostedSteward, initialState } from '../hosted/steward.js';
import { HostedCoding, codingConfig } from '../hosted/coding.js';
import { validatedSpec } from '../../../src/task-policy.js';
const original = JSON.parse(await readFile(new URL('../../../fixtures/steward-project.json', import.meta.url)));
const project = structuredClone(original); project.codingCandidates[0].spec.mode = 'live';
const spec = validatedSpec(project.codingCandidates[0].spec);
const proposal = { kind: 'coding', candidateId: project.codingCandidates[0].id, title: 'Normalize links', rationale: 'Approved brief requires this fix.', citations: project.codingCandidates[0].sourceIds, question: null };
const ask = { requestId: 'connection-one', projectId: project.id, message: 'Propose the known coding task.' };
const nextProject = { ...structuredClone(project), id: 'agent-workbench', name: 'Agent Workbench', objective: 'Connect the hosted coding handoff.', codingCandidates: [] };
nextProject.sources = [{ ...nextProject.sources[0], content: 'Build the hosted coding connection. Keep all prior history and allowance.' }];
const config = { spec, token: 'synthetic-trigger-secret-for-local-tests', githubToken: 'synthetic-read-token', verifiedUntil: '2026-09-20T12:00:00.000Z' };
const accepted = { outcome: 'accepted', status: 200, session: { id: 'session_TEST', url: 'https://claude.ai/code/session_TEST' } };
async function fixture(t, options = {}) {
  const pool = new TestPool(); t.after(() => pool.end()); await pool.query(stateSchema);
  const store = new HostedStore(pool, { ownerId: 'owner@example.com', projectId: project.id });
  await store.initialize(initialState(project, { model: 'anthropic/claude-opus-5', budgetMicros: 1000000 }));
  let time = '2026-09-19T12:00:00.000Z'; const now = () => time; let calls = 0;
  const read = options.read ?? (async path => path.includes('/commits/') ? { sha: spec.baseSha } : { full_name: spec.repository, private: false, default_branch: spec.baseBranch });
  const send = async input => { calls++; const state = await store.read(); assert.equal(state.coding.jobs[ask.requestId].dispatch, 'unknown'); assert.equal(state.coding.jobs[ask.requestId].approval.consumed, true); assert.ok(!input.text.includes(config.token)); return options.send ? options.send(input) : accepted; };
  const coding = new HostedCoding(store, { config: structuredClone(config), send, read, now });
  const steward = new HostedSteward(store, async input => { await store.change(state => { state.requests[input.hostedRequestId].provider = { intentAt: now(), sessionId: 'model-test', httpStatus: 200, reservedMicros: 100 }; state.reservedMicros += 100; }); return options.proposal ?? proposal; }, { now, coding });
  return { store, steward, coding, now, send, read, calls: () => calls, advance: value => { time = value; } };
}
async function reviewed(f) { const r = await f.steward.propose(ask); const review = await f.coding.review({ requestId: r.id, proposalHash: r.proposalHash }); return { requestId: r.id, proposalHash: r.proposalHash, reviewHash: review.reviewHash }; }

test('context adoption preserves history, budget, pause and Telegram binding and cannot revive old approvals', async t => {
  const f = await fixture(t, { proposal: { ...proposal, kind: 'commitment', candidateId: null } });
  const r = await f.steward.propose(ask); await f.steward.approve({ requestId: r.id, proposalHash: r.proposalHash });
  await f.store.change(s => { s.telegram = { binding: 'owner-binding', updates: { saved: { status: 'sent' } } }; s.paused = true; });
  const before = await f.store.read(); const preview = await f.steward.previewContext(nextProject);
  const applied = await f.steward.applyContext({ previewId: preview.id, expectedRevision: preview.expectedRevision });
  const restarted = new HostedSteward(new HostedStore(f.store.pool, { ownerId: f.store.ownerId, projectId: f.store.projectId }), async () => assert.fail('no model'), { now: f.now });
  assert.deepEqual(await restarted.applyContext({ previewId: preview.id, expectedRevision: preview.expectedRevision }), applied);
  const state = await f.store.read(); assert.deepEqual(state.requests, before.requests); assert.deepEqual(state.commitments, before.commitments);
  assert.deepEqual(state.telegram, before.telegram); assert.equal(state.reservedMicros, 100); assert.equal(state.budgetMicros, 1000000); assert.equal(state.paused, true);
  assert.equal((await restarted.view()).providerAttempts, 1); assert.equal((await restarted.view()).commitments.length, 0); assert.equal((await restarted.view()).historicalCommitments.length, 1);
  await assert.rejects(restarted.approve({ requestId: r.id, proposalHash: r.proposalHash }), /MISMATCH/);
  const back = await restarted.previewContext(project); await restarted.applyContext({ previewId: back.id, expectedRevision: back.expectedRevision });
  assert.notEqual((await f.store.read()).project.revision, before.project.revision);
  await assert.rejects(restarted.approve({ requestId: r.id, proposalHash: r.proposalHash }), /MISMATCH/);
});

test('stale/concurrent context previews and held or active work cannot change context', async t => {
  const f = await fixture(t); const first = await f.steward.previewContext(nextProject);
  const second = await f.steward.previewContext({ ...nextProject, objective: 'Other objective' });
  await assert.rejects(f.steward.applyContext({ previewId: first.id, expectedRevision: first.expectedRevision }), /STALE/);
  const pair = await Promise.all([f.steward.applyContext({ previewId: second.id, expectedRevision: second.expectedRevision }), f.steward.applyContext({ previewId: second.id, expectedRevision: second.expectedRevision })]);
  assert.deepEqual(pair[0], pair[1]); assert.equal((await f.store.read()).contextChanges.length, 1);
  const third = await f.steward.previewContext(project); await f.store.change(s => { s.requests.uncertain = { status: 'held' }; });
  await assert.rejects(f.steward.applyContext({ previewId: third.id, expectedRevision: third.expectedRevision }), /UNRESOLVED/);
  await assert.rejects(f.steward.previewContext(project), /UNRESOLVED/);
  await f.store.change(s => { delete s.requests.uncertain; s.coding = { active: 'some-job', jobs: {} }; });
  await assert.rejects(f.steward.previewContext(project), /UNRESOLVED/);
});

test('new project judgments use active identity and budget cannot restart after a context switch', async t => {
  const f = await fixture(t, { proposal: { kind: 'clarify', candidateId: null, title: 'Ask owner', rationale: 'Needs context', citations: ['brief'], question: 'What next?' } });
  for (let i=0;i<5;i++) await f.steward.propose({ ...ask, requestId: `prior-${i}` });
  const preview = await f.steward.previewContext(nextProject); await f.steward.applyContext({ previewId: preview.id, expectedRevision: preview.expectedRevision });
  await assert.rejects(f.steward.propose({ ...ask, projectId: nextProject.id }), /ADMISSION_PAUSED/);
  await assert.rejects(f.steward.propose(ask), /INVALID_REQUEST/);
  assert.equal((await f.steward.view()).providerAttempts, 5);
});

test('two instances consume exact web approval once and persist intent before the single fire', async t => {
  let resolve; const f = await fixture(t, { send: () => new Promise(r => { resolve = r; }) });
  const approval = await reviewed(f);
  const second = new HostedCoding(f.store, { config, send: f.send, read: f.read, now: f.now });
  const first = f.coding.approveAndDispatch(approval);
  while (!resolve) await new Promise(r => setTimeout(r, 1));
  assert.equal((await second.approveAndDispatch(approval)).dispatch, 'unknown');
  await f.steward.pause(); resolve(accepted); const result = await first;
  assert.equal(result.dispatch, 'accepted'); assert.equal(result.stopRequested, true); assert.equal(f.calls(), 1);
  assert.equal((await second.approveAndDispatch(approval)).dispatch, 'accepted'); assert.equal(f.calls(), 1);
  assert.ok(!JSON.stringify(await f.store.read()).includes(config.token));
  await assert.rejects(f.steward.previewContext(nextProject), /UNRESOLVED/);
});

test('lost fire response survives restart without dispatch retry or premature release', async t => {
  const f = await fixture(t, { send: async () => { throw Error(config.token); } }); const approval = await reviewed(f);
  assert.equal((await f.coding.approveAndDispatch(approval)).dispatch, 'unknown');
  const restarted = new HostedCoding(f.store, { config, send: () => assert.fail('no second fire'), read: f.read, now: f.now });
  assert.equal((await restarted.approveAndDispatch(approval)).dispatch, 'unknown');
  await assert.rejects(restarted.release({ requestId: ask.requestId }), /UNVERIFIED/);
  await assert.rejects(restarted.approveAndDispatch({ ...approval, reviewHash: 'wrong' }), /MISMATCH/);
  assert.equal(f.calls(), 1); assert.ok(!JSON.stringify(await f.store.read()).includes(config.token));
});

test('expired approval, context/config changes, and public/private base drift deny dispatch before I/O', async t => {
  for (const reason of ['expired','context','config','visibility','base']) {
    const f = await fixture(t); const approval = await reviewed(f);
    if (reason === 'expired') f.advance('2026-09-19T12:16:00.000Z');
    if (reason === 'context') { const p = await f.steward.previewContext(nextProject); await f.steward.applyContext({ previewId:p.id, expectedRevision:p.expectedRevision }); }
    if (reason === 'config') f.coding.config.verifiedUntil = '2026-09-21T00:00:00Z';
    if (reason === 'visibility') f.coding.read = async path => path.includes('/commits/') ? { sha: spec.baseSha } : { full_name: spec.repository, default_branch: spec.baseBranch, private: true };
    if (reason === 'base') f.coding.read = async path => path.includes('/commits/') ? { sha: 'f'.repeat(40) } : { full_name: spec.repository, default_branch: spec.baseBranch, private: false };
    await assert.rejects(f.coding.approveAndDispatch(approval), /MISMATCH|PREFLIGHT/); assert.equal(f.calls(), 0);
  }
});

test('provider rejection pauses coding and cannot consume the same task again', async t => {
  const f=await fixture(t,{send:async()=>({outcome:'usage_limited',status:429})});const approval=await reviewed(f);
  const r=await f.coding.approveAndDispatch(approval);assert.equal(r.dispatch,'usage_limited');assert.equal((await f.store.read()).coding.paused,true);
  await f.coding.approveAndDispatch(approval);assert.equal(f.calls(),1);
});

test('evidence preserves uncertainty; release requires provider termination then fresh reconciliation', async t => {
  const f=await fixture(t,{send:async()=>({outcome:'unknown'})}); const approval=await reviewed(f);await f.coding.approveAndDispatch(approval);
  f.coding.read=async path=>path.includes('/pulls?')?[]:null;
  await f.coding.reconcile({requestId:ask.requestId});
  f.advance('2026-09-19T12:01:00.000Z');
  await f.coding.observe({requestId:ask.requestId,sessionId:'session_TEST',sessionUrl:'https://claude.ai/code/session_TEST',execution:'exited',observedAt:f.now(),markerVerified:true});
  await assert.rejects(f.coding.release({requestId:ask.requestId}),/UNVERIFIED/);
  await f.coding.reconcile({requestId:ask.requestId});await f.coding.release({requestId:ask.requestId});
  const task=(await f.store.read()).coding.jobs[ask.requestId]; assert.equal(task.dispatch,'unknown');assert.equal(task.result.result,'not_found');assert.equal((await f.store.read()).coding.active,null);
});

test('coding configuration is disabled by default and rejects absent no-overage verification',()=>{
  assert.equal(codingConfig({}),null);assert.throws(()=>codingConfig({WORKBENCH_CODING_ENABLED:'yes'}),/INVALID/);
});


test('a later running observation reclaims a released slot and blocks context changes', async t => {
  const f=await fixture(t);const approval=await reviewed(f);await f.coding.approveAndDispatch(approval);
  f.coding.read=async path=>path.includes('/pulls?')?[]:null;
  f.advance('2026-09-19T12:01:00.000Z');
  const observation={requestId:ask.requestId,sessionId:'session_TEST',sessionUrl:'https://claude.ai/code/session_TEST',execution:'exited',observedAt:f.now(),markerVerified:true};
  await f.coding.observe(observation);await f.coding.reconcile({requestId:ask.requestId});await f.coding.release({requestId:ask.requestId});
  f.advance('2026-09-19T12:02:00.000Z');await f.coding.observe({...observation,execution:'running',observedAt:f.now()});
  const state=await f.store.read();assert.equal(state.coding.active,ask.requestId);assert.equal(state.coding.paused,true);assert.equal(state.coding.jobs[ask.requestId].releasedAt,undefined);
  await assert.rejects(f.steward.previewContext(nextProject),/UNRESOLVED/);
});

test('a queued Telegram update blocks context adoption and stale received revision denies judgment', async t => {
  const f=await fixture(t);const oldRevision=(await f.store.read()).project.revision;
  const p=await f.steward.previewContext(nextProject);
  await f.store.change(s=>{s.telegram={binding:'owner',updates:{queued:{status:'accepted',projectId:s.project.id,contextRevision:s.project.revision}}};});
  await assert.rejects(f.steward.applyContext({previewId:p.id,expectedRevision:p.expectedRevision}),/UNRESOLVED/);
  await f.store.change(s=>{s.telegram.updates.queued.status='sent';});
  await f.steward.applyContext({previewId:p.id,expectedRevision:p.expectedRevision});
  await assert.rejects(f.steward.propose({...ask,projectId:nextProject.id,expectedContextRevision:oldRevision}),/INVALID_REQUEST/);
  assert.equal((await f.steward.view()).providerAttempts,0);
});
