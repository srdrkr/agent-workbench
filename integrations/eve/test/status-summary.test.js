import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HostedSteward, initialState } from '../hosted/steward.js';
import { statusSummary, ownerState, STATUS_SUMMARY_LIMIT, STALLED_AFTER_MS } from '../shared/status-summary.js';

// Regression coverage uses the application's own persisted state: the initial
// state, records written by propose/approve/pause/context changes, coding job
// fields exactly as hosted/coding.js records them, and the real steward view.
const project = JSON.parse(await readFile(new URL('../../../fixtures/steward-project.json', import.meta.url)));
const MODEL = 'anthropic/claude-opus-5';
const LINK = 'https://steward.example.com';
const proposal = { kind: 'commitment', candidateId: null, title: 'Review the blocker', rationale: 'The brief needs an owner decision.', citations: ['brief'], question: null };
let clock = Date.parse('2026-09-21T09:00:00.000Z');
const now = () => new Date(clock += 60_000).toISOString();
const parts = text => Object.fromEntries(text.split('\n')[0].split(/\. (?=Blocker: |Next: )/).map(p => p.split(': ')).map(([k, ...v]) => [k, v.join(': ').replace(/\.$/, '')]));

// Same contract as HostedStore: synchronous actions over one persisted state object.
function memoryStore(state) {
  return { read: async () => structuredClone(state), change: async action => { const value = action(state); if (value && typeof value.then === 'function') throw new Error('STATE_ACTION_MUST_BE_SYNCHRONOUS'); return value; } };
}
function workspace({ budgetMicros = 1_000_000, reserve = 1, judge = async () => proposal } = {}) {
  const state = initialState(project, { model: MODEL, budgetMicros });
  const store = memoryStore(state);
  const steward = new HostedSteward(store, async input => {
    // The hosted transport records the reservation before the model answers (hosted/transport.js).
    await store.change(s => { s.requests[input.hostedRequestId].provider = { intentAt: now(), httpStatus: 200, sessionId: 'synthetic-session', reservedMicros: reserve }; s.reservedMicros += reserve; });
    return judge(input);
  }, { now });
  const summary = async link => statusSummary(await steward.view(), link ? { link } : {});
  return { state, store, steward, summary };
}
let requestNumber = 0;
const ask = () => ({ requestId: `request-${++requestNumber}`, projectId: project.id, message: 'What should I commit to next?' });

// Mirrors the fields hosted/coding.js writes at approve (intent), dispatch (receipt),
// observe (owner-verified session state), reconcile (GitHub evidence) and release.
function codingJob(state, { id = 'job-1', dispatch = 'unknown', execution = 'unobserved', result = null, released = false } = {}) {
  const c = state.coding ??= { jobs: {}, active: null, paused: false };
  const event = (kind, data) => { const seq = state.events.length + 1; state.events.push({ seq, kind, data, at: now() }); return seq; };
  const spec = structuredClone(project.codingCandidates[0].spec);
  const task = { id, projectId: state.project.id, spec, scopeHash: 'synthetic-scope', contextRevision: state.project.revision,
    branch: `claude/workbench-task-${spec.taskId}`, marker: `<!-- workbench:${spec.taskId} -->`, dispatch: 'unknown', execution: 'unobserved', stopRequested: false,
    dispatchStartedAt: now(), approval: { reviewHash: 'synthetic-review', proposalHash: 'synthetic-proposal', consumed: true, action: 'one_routine_fire', source: 'authenticated_owner_web', incrementalSpendUsd: 0 }, result: null };
  c.jobs[id] = task; c.active = id; event('coding_dispatch_intent', { requestId: id });
  task.dispatch = dispatch; task.receipt = { outcome: dispatch, source: 'routines_api', observedAt: now() };
  if (['rejected', 'usage_limited'].includes(dispatch)) { c.active = null; c.paused = true; }
  event('coding_dispatch_observed', { requestId: id, outcome: dispatch });
  if (execution !== 'unobserved') {
    task.session = { id: 'session_synthetic', url: 'https://claude.ai/code/session_synthetic' }; task.execution = execution;
    task.executionObservation = { source: 'owner_provider_ui', state: execution, observedAt: now(), markerVerified: true, recordedEvent: event('coding_provider_observed', { requestId: id, execution }) };
  }
  if (result) {
    const seq = event('coding_reconciliation_started', { requestId: id });
    task.result = { result, prUrl: result === 'not_found' || result === 'branch_without_pr' ? undefined : 'https://github.com/example-owner/workbench-routine-sandbox/pull/7', headSha: 'a'.repeat(40), collectionStartedAt: now(), collectionStartedEvent: seq, observedAt: now() };
    event('coding_result_observed', { requestId: id, result });
  }
  if (released) { c.active = null; task.releasedAt = now(); event('coding_admission_released', { requestId: id }); }
  return task;
}

test('the persisted initial state reports no progress and a safe next step', async () => {
  const w = workspace();
  const text = await w.summary();
  assert.equal(text, 'Progress: no recorded progress yet. Blocker: none recorded. Next: ask Eve for the next useful step.');
  assert.ok(text.length <= STATUS_SUMMARY_LIMIT);
  assert.equal(statusSummary(null), text);
});

test('unknown dispatch and unobserved sessions never read as Claude working', async () => {
  const w = workspace();
  codingJob(w.state, { dispatch: 'unknown' });
  let p = parts(await w.summary());
  assert.equal(p.Progress, 'Claude start unconfirmed for: Trim whitespace and collapse runs of spaces or hyphens in generated slugs');
  assert.equal(p.Blocker, 'coding start unconfirmed; check Claude first');
  assert.equal(p.Next, 'check Claude, then confirm or close the run');
  assert.doesNotMatch(await w.summary(), /working/i);

  w.state.coding = undefined; codingJob(w.state, { dispatch: 'accepted' });
  p = parts(await w.summary());
  assert.equal(p.Progress, 'sent to Claude, no GitHub result yet: Trim whitespace and collapse runs of spaces or hyphens in generated slugs');
  assert.equal(p.Next, 'wait for GitHub progress; confirm when Claude finishes');
  assert.doesNotMatch(await w.summary(), /working/i);

  w.state.coding = undefined; codingJob(w.state, { dispatch: 'accepted', execution: 'running' });
  p = parts(await w.summary());
  assert.equal(p.Progress, 'Claude observed running, no GitHub result yet: Trim whitespace and collapse runs of spaces or hyphens in generated slugs');
  assert.equal(p.Next, 'wait for Claude; check GitHub later');

  w.state.coding = undefined; codingJob(w.state, { dispatch: 'usage_limited' });
  p = parts(await w.summary());
  assert.equal(p.Progress, 'Claude could not start: Trim whitespace and collapse runs of spaces or hyphens in generated slugs');
  assert.equal(p.Blocker, 'Claude usage limit; coding did not start');
  assert.equal(p.Next, 'review the failed coding start in the web app');
});

test('an exited session with a tested draft PR asks to close the run and never claims completion', async () => {
  const w = workspace();
  for (const execution of ['exited', 'stopped']) {
    w.state.coding = undefined; codingJob(w.state, { dispatch: 'accepted', execution, result: 'tested_draft_pr' });
    const text = await w.summary(LINK);
    assert.deepEqual(parts(text), { Progress: 'draft PR passed required checks; Claude ended, run not closed', Blocker: 'none recorded', Next: 'close the coding run, then review the draft PR' });
    assert.doesNotMatch(text, /working|merged|deployed|complete/i);
    assert.ok(text.endsWith(`\n${LINK}`)); assert.ok(text.length <= STATUS_SUMMARY_LIMIT);
  }
  w.state.coding = undefined; codingJob(w.state, { dispatch: 'accepted', result: 'tested_draft_pr' });
  assert.equal(parts(await w.summary()).Progress, 'draft PR passed required checks; Claude finish unconfirmed');
  assert.equal(parts(await w.summary()).Next, 'confirm Claude finished, then review the draft PR');
});

test('an empty current-project jobs list is authoritative after the brief changes', async () => {
  const w = workspace();
  codingJob(w.state, { dispatch: 'accepted', execution: 'exited', result: 'tested_draft_pr', released: true });
  assert.match(parts(await w.summary()).Progress, /draft PR passed required checks/);
  const preview = await w.steward.previewContext({ ...project, id: 'next-project', name: 'Next project', codingCandidates: [] });
  await w.steward.applyContext({ previewId: preview.id, expectedRevision: preview.expectedRevision });
  const view = await w.steward.view();
  assert.equal(view.progress.jobs.length, 0); assert.equal(view.codingJobs.length, 1);
  const text = await w.summary();
  assert.equal(text, 'Progress: no recorded progress yet. Blocker: none recorded. Next: ask Eve for the next useful step.');
  assert.doesNotMatch(text, /PR|slug/);
  // A view without the progress projection still keeps other projects' jobs out.
  const { progress, ...legacy } = view;
  assert.equal(statusSummary(legacy), text);
});

test('an exhausted dollar allowance is reported on its own and is never reset or refilled', async () => {
  const w = workspace({ budgetMicros: 250_000, reserve: 250_000 });
  await w.steward.propose(ask());
  const before = structuredClone(w.state);
  const p = parts(await w.summary());
  assert.equal(p.Blocker, 'model allowance used up ($0.25 of $0.25 reserved)');
  assert.equal(p.Next, 'review the pilot allowance; no automatic top-up');
  assert.equal(p.Progress, 'no recorded progress yet');
  const view = await w.steward.view();
  assert.equal(view.providerAttempts, 1); assert.equal(view.maxProviderAttempts, 5);
  assert.deepEqual(w.state, before);
  assert.equal(w.state.budgetMicros, 250_000); assert.equal(w.state.reservedMicros, 250_000);

  const counted = workspace({ budgetMicros: 1_000_000, reserve: 1 });
  counted.state.maxProviderAttempts = 1;
  await counted.steward.propose(ask());
  const q = parts(await counted.summary());
  assert.equal(q.Blocker, 'request limit reached (1 of 1 attempts)');
  assert.equal(q.Next, 'review the pilot allowance');
  assert.equal((await counted.steward.view()).reservedMicros, 1);
});

test('an unmerged PR stays awaiting review after its coding run closes', async () => {
  const w = workspace();
  await w.steward.propose(ask());
  assert.equal(parts(await w.summary()).Next, 'decide on the proposal: Review the blocker');
  for (const [result, progress, next] of [
    ['tested_draft_pr', 'draft PR passed required checks; run closed, PR not merged', 'review the unmerged PR'],
    ['needs_review', 'PR open; checks or review pending; run closed, PR not merged', 'review the unmerged PR'],
    ['branch_without_pr', 'branch pushed; no PR yet; run closed, no PR', 'check the pushed branch; no PR yet'],
  ]) {
    w.state.coding = undefined; codingJob(w.state, { dispatch: 'accepted', execution: 'exited', result, released: true });
    const p = parts(await w.summary());
    assert.equal(p.Progress, progress); assert.equal(p.Blocker, 'none recorded'); assert.equal(p.Next, next);
  }
  w.state.coding = undefined; codingJob(w.state, { dispatch: 'accepted', execution: 'exited', result: 'merged_pr', released: true });
  const p = parts(await w.summary());
  assert.equal(p.Progress, 'PR merged; deployment not verified');
  assert.equal(p.Next, 'decide on the proposal: Review the blocker');
});

test('paused with unresolved work recommends resolving it before resuming', async () => {
  const idle = workspace();
  await idle.steward.pause();
  assert.deepEqual(parts(await idle.summary()), { Progress: 'no recorded progress yet', Blocker: 'new model requests paused', Next: 'resume requests when ready' });

  const held = workspace({ judge: async () => { throw new Error('synthetic gateway failure'); } });
  const record = await held.steward.propose(ask());
  assert.equal(record.status, 'held');
  await held.steward.pause();
  assert.equal(parts(await held.summary()).Next, 'review the held attempt before resuming');
  await assert.rejects(held.steward.resume(), /UNRESOLVED_MODEL_ATTEMPT/);

  const running = workspace();
  codingJob(running.state, { dispatch: 'accepted', execution: 'running' });
  await running.steward.pause();
  assert.equal(running.state.coding.jobs['job-1'].stopRequested, true);
  const p = parts(await running.summary());
  assert.equal(p.Blocker, 'new model requests paused'); assert.equal(p.Next, 'check Claude and close the run before resuming');
  await assert.rejects(running.steward.resume(), /UNRESOLVED_MODEL_ATTEMPT/);

  const ended = workspace();
  codingJob(ended.state, { dispatch: 'accepted', execution: 'exited', result: 'tested_draft_pr' });
  await ended.steward.pause();
  assert.equal(parts(await ended.summary()).Next, 'close the coding run before resuming');
});

test('owner-reported completion and pending decisions use recorded titles only', async () => {
  const w = workspace();
  const first = await w.steward.propose(ask());
  await w.steward.approve({ requestId: first.id, proposalHash: first.proposalHash });
  assert.equal(parts(await w.summary()).Progress, 'committed, not yet done: Review the blocker');
  assert.equal(parts(await w.summary()).Next, 'work on: Review the blocker');
  await w.steward.completeCommitment({ commitmentId: first.id, expectedContextRevision: w.state.project.revision });
  const second = await w.steward.propose({ ...ask(), message: 'And after that?' });
  assert.equal(second.status, 'awaiting_approval');
  const p = parts(await w.summary());
  assert.equal(p.Progress, 'owner reported done: Review the blocker');
  assert.equal(p.Next, 'decide on the proposal: Review the blocker');
});

test('long titles, notes and links stay within 280 characters with the link intact', () => {
  const long = 'A very long recorded title that keeps going far beyond anything a short status could carry '.repeat(4);
  const view = { project: { id: 'p', revision: 'r' }, contextFresh: true, providerAttempts: 1, maxProviderAttempts: 5, budgetMicros: 1_000_000, reservedMicros: 1,
    requests: [{ id: 'r', status: 'awaiting_approval', contextRevision: 'r', proposal: { kind: 'commitment', title: long } }],
    progress: { notes: [{ id: 'n', kind: 'note', text: long }], priority: null, commitments: [], jobs: [] } };
  for (const link of ['', LINK, `${LINK}/${'p'.repeat(120)}`]) {
    const text = statusSummary(view, { link });
    assert.ok(text.length <= STATUS_SUMMARY_LIMIT, `${text.length} > ${STATUS_SUMMARY_LIMIT}`);
    if (link) assert.ok(text.endsWith(`\n${link}`));
    assert.match(text, /^Progress: latest note: .+…\. Blocker: none recorded\. Next: decide on the proposal: .+…\./);
  }
});

test('the same persisted state gives the same text on both surfaces', async () => {
  const w = workspace();
  codingJob(w.state, { dispatch: 'accepted', result: 'branch_without_pr' });
  const web = await w.summary();
  assert.equal(await w.summary(LINK), `${web}\n${LINK}`);
  assert.equal(await w.summary(), web);
});


test('recorded execution supersedes an unknown dispatch receipt', async () => {
  for (const execution of ['running', 'exited', 'stopped']) {
    for (const result of [null, 'tested_draft_pr']) {
      const w = workspace();
      codingJob(w.state, { dispatch: 'unknown', execution, result });
      const p = parts(await w.summary());
      assert.doesNotMatch(p.Progress, /start unconfirmed/);
      assert.equal(p.Blocker, 'none recorded');
      assert.equal(p.Next, execution === 'running' ? 'wait for Claude; check GitHub later'
        : result ? 'close the coding run, then review the draft PR' : 'check GitHub, then close the coding run');
      assert.equal(w.state.coding.jobs['job-1'].dispatch, 'unknown');
    }
  }
});

test('exhausted allowance keeps unresolved work ahead of a blocked allowance review', async () => {
  for (const limit of ['dollars', 'attempts']) {
    const w = workspace({ budgetMicros: limit === 'dollars' ? 1 : 100, reserve: 1,
      judge: async () => { throw new Error('synthetic provider failure'); } });
    if (limit === 'attempts') w.state.maxProviderAttempts = 1;
    const request = await w.steward.propose(ask());
    assert.equal(request.status, 'held');
    const p = parts(await w.summary());
    assert.match(p.Blocker, limit === 'dollars' ? /allowance used up/ : /request limit reached/);
    // With the outcome-1 recovery projection this held proposal (2xx, no verified result) is unverified output.
    assert.equal(p.Next, 'operator: check the held attempt; do not resend');
  }
  const w = workspace();
  w.state.reservedMicros = w.state.budgetMicros;
  codingJob(w.state, { dispatch: 'unknown', execution: 'exited', result: 'tested_draft_pr' });
  assert.equal(parts(await w.summary()).Next, 'close the coding run, then review the draft PR');
});

// Owner-state coverage. The state is part of the same Next branch, so both surfaces agree.
const stateOf = text => text.match(/^State: ([^.]+)\./)?.[1];
const both = (view, options = {}) => { const text = statusSummary(view, { ...options, state: true }); assert.equal(stateOf(text), ownerState(view, options).label); return { text, key: ownerState(view, options).key, p: parts(text.replace(/^State: [^.]+\. /, '')) }; };
function heldJudge() {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let called; const calledSignal = new Promise(resolve => { called = resolve; });
  return { judge: async () => { called(); await gate; return proposal; }, release, called: calledSignal };
}

test('a request in progress reads as working everywhere and never asks for it again', async () => {
  const h = heldJudge(); const w = workspace({ judge: h.judge });
  const first = ask(); const running = w.steward.propose(first);
  await h.called;
  const view = await w.steward.view();
  assert.equal(view.requests[0].status, 'thinking');
  let r = both(view);
  assert.equal(r.key, 'working'); assert.match(r.text, /^State: In progress\./);
  assert.equal(r.p.Next, "wait for Eve's answer; no need to send the request again");
  assert.equal(r.p.Blocker, 'none; Eve is working on your request');
  assert.doesNotMatch(r.text, /ask Eve|ask again|submit/i);
  // An expired brief or a pause cannot be acted on until the request ends, so working still leads.
  r = both({ ...view, contextFresh: false }); assert.equal(r.key, 'working'); assert.match(r.p.Next, /no need to send/);
  r = both({ ...view, paused: true }); assert.equal(r.key, 'working'); assert.equal(r.p.Next, 'wait for Eve before resuming');
  // Existing duplicate-admission guards are unchanged while it runs.
  await assert.rejects(w.steward.propose(ask()), /UNRESOLVED_MODEL_ATTEMPT/);
  await assert.rejects(w.steward.propose({ ...first, message: 'different text' }), /REQUEST_ID_CONFLICT/);
  h.release(); const done = await running;
  assert.equal(done.status, 'awaiting_approval');
  r = both(await w.steward.view());
  assert.equal(r.key, 'awaiting_decision'); assert.match(r.text, /^State: Your decision needed\./);
  assert.equal(r.p.Next, 'decide on the proposal: Review the blocker');
  assert.doesNotMatch(r.text, /done|executed|completed|committed/i);
  await w.steward.approve({ requestId: done.id, proposalHash: done.proposalHash });
  r = both(await w.steward.view());
  assert.equal(r.key, 'completed'); assert.match(r.text, /^State: Decision recorded\. Progress: committed, not yet done: Review the blocker/);
  assert.equal(r.p.Next, 'work on: Review the blocker');
  await w.steward.completeCommitment({ commitmentId: done.id, expectedContextRevision: w.state.project.revision });
  r = both(await w.steward.view());
  assert.equal(r.key, 'completed'); assert.match(r.text, /^State: Completed\. Progress: owner reported done: Review the blocker/);
  assert.equal(r.p.Next, 'ask Eve for the next useful step');
});

test('a recorded request older than the hosted limit is stalled and blocked, never working', async () => {
  const h = heldJudge(); const w = workspace({ judge: h.judge });
  const running = w.steward.propose(ask()); await h.called;
  const view = await w.steward.view();
  const createdAt = Date.parse(view.requests[0].createdAt);
  let r = both(view, { now: new Date(createdAt + STALLED_AFTER_MS - 1000).toISOString() });
  assert.equal(r.key, 'working');
  r = both(view, { now: new Date(createdAt + STALLED_AFTER_MS + 1000).toISOString() });
  assert.equal(r.key, 'blocked'); assert.equal(r.p.Blocker, 'no result recorded from Eve; outcome unknown');
  assert.equal(r.p.Next, 'ask the operator to check the stalled request; do not resend it');
  // The view's own server time gives the same answer; a local, not yet recorded submission is never stalled.
  assert.equal(both({ ...view, observedAt: new Date(createdAt + STALLED_AFTER_MS + 1000).toISOString() }).key, 'blocked');
  const local = { ...view, observedAt: new Date(createdAt + 3600000).toISOString(), requests: [{ ...view.requests[0], local: true }] };
  assert.equal(both(local).key, 'working');
  h.release(); await running;
});

test('terminal request outcomes each point to their next action', async () => {
  const clarify = workspace({ judge: async () => ({ kind: 'clarify', candidateId: null, title: 'Which pages matter first?', rationale: 'The brief lists two areas.', citations: ['brief'], question: 'Should help-centre links or blog links come first?' }) });
  assert.equal((await clarify.steward.propose(ask())).status, 'needs_context');
  let r = both(await clarify.steward.view());
  assert.equal(r.key, 'awaiting_decision');
  assert.equal(r.p.Next, "answer Eve's question in a new request: Should help-centre links or blog links come first?");

  // not_sent means the provider was never admitted (no intent recorded); the view below is that recorded shape.
  const unsent = { project: { id: 'p', revision: 'r' }, contextFresh: true, providerAttempts: 0, maxProviderAttempts: 5, budgetMicros: 10, reservedMicros: 0,
    requests: [{ id: 'n', status: 'not_sent', contextRevision: 'r', createdAt: '2026-09-21T10:00:00.000Z' }], progress: { notes: [], priority: null, commitments: [], jobs: [] } };
  r = both(unsent); assert.equal(r.key, 'blocked'); assert.equal(r.p.Blocker, 'the last request was not sent'); assert.equal(r.p.Next, 'check the allowance and brief size, then ask again');

  const held = workspace({ judge: async () => { throw new Error('synthetic gateway failure'); } });
  assert.equal((await held.steward.propose(ask())).status, 'held');
  r = both(await held.steward.view()); assert.equal(r.key, 'blocked'); assert.equal(r.p.Next, 'operator: check the held attempt; do not resend');
  assert.equal(r.p.Blocker, 'held attempt output not verified');
  // Without a recovery projection (a view from before outcome 1) the generic text remains.
  const plain = await held.steward.view(); plain.requests = plain.requests.map(({ recovery, ...rest }) => rest);
  assert.equal(both(plain).p.Next, 'review the held attempt');
});

test('the four owner states are distinct and stay within 280 characters with the link', async () => {
  const labels = new Set();
  const h = heldJudge(); const w = workspace({ judge: h.judge });
  const running = w.steward.propose(ask()); await h.called;
  const views = [await w.steward.view()];
  h.release(); const done = await running; views.push(await w.steward.view());
  const held = workspace({ judge: async () => { throw new Error('synthetic'); } }); await held.steward.propose(ask()); views.push(await held.steward.view());
  await w.steward.approve({ requestId: done.id, proposalHash: done.proposalHash });
  await w.steward.completeCommitment({ commitmentId: done.id, expectedContextRevision: w.state.project.revision }); views.push(await w.steward.view());
  const keys = views.map(v => ownerState(v).key);
  assert.deepEqual(keys, ['working', 'awaiting_decision', 'blocked', 'completed']);
  for (const v of views) { const text = statusSummary(v, { state: true, link: `${LINK}/${'p'.repeat(120)}` }); labels.add(stateOf(text)); assert.ok(text.length <= STATUS_SUMMARY_LIMIT); }
  assert.equal(labels.size, 4);
});
