import { HostedCoding } from '../hosted/coding.js';
import { hostedTransport, HOSTED_MODEL } from '../hosted/transport.js';
import { digest } from '../hosted/steward.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FollowThrough, followThroughGrant, followThroughView, notifyFollowThrough } from '../hosted/follow-through.js';
import { codeReviewPacket, createCodeReview } from '../hosted/code-review.js';
import { codeReviewSchema } from '../schema.js';

const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40);
function fixture({ results = [], correct, observed = true } = {}) {
  let clock = Date.parse('2026-09-21T10:00:00Z');
  const now = () => new Date(clock).toISOString();
  const task = { id: 'task1', projectId: 'p', contextRevision: 'r', scopeHash: 'scope', branch: 'claude/task', marker: '<!-- task -->', dispatchStartedAt: now(),
    spec: { repository: 'owner/repo', visibility: 'public', baseBranch: 'main', baseSha: '0'.repeat(40), requiredChecks: [], allowedPaths: ['slug.js'], objective: 'Normalize slugs', acceptance: 'Collapse whitespace' },
    dispatch: 'accepted', execution: observed ? 'exited' : 'unobserved', executionObservation: observed ? { markerVerified: true, recordedEvent: 1 } : null,
    result: { source: 'github_api', result: 'tested_draft_pr', headSha: A, prNumber: 5, scopeMatches: true, approvedBase: true, collectionStartedEvent: 2 } };
  task.followThrough = { grant: followThroughGrant(task, now()), status: 'waiting_for_pr', activeJobId: task.id, reviews: [], attempts: [], nextCheckAt: now() };
  const state = { pilot: {}, project: { id: 'p', revision: 'r', sources: [{ observedAt: now(), expiresAt: '2026-09-23T00:00:00Z' }] },
    reservedMicros: 1, budgetMicros: 10_000_000, requests: {}, events: [], coding: { jobs: { task1: task }, active: task.id } };
  const store = { read: async () => structuredClone(state), change: async action => action(state) };
  let calls = 0; let sends = 0;
  const coding = { reconcile: async ({ requestId }) => structuredClone(state.coding.jobs[requestId]) };
  const controller = new FollowThrough({ store, coding, now, review: async () => { calls++; return results.shift() ?? { verdict: 'ready', summary: 'No defect found', findings: [] }; },
    correct: correct === null ? null : async input => {
      sends++;
      if (correct) return correct(input);
      const next = { ...structuredClone(input.previous), id: input.attempt.id, followThrough: undefined,
        execution: 'unobserved', executionObservation: null, result: null, session: { id: 'session_synthetic' } };
      input.previous.releasedAt = now(); state.coding.jobs[next.id] = next; state.coding.active = next.id;
      return { outcome: 'accepted' };
    } });
  const tick = () => { clock += 16 * 60000; };
  const finish = head => {
    const job = state.coding.jobs[task.followThrough.activeJobId];
    job.execution = 'exited'; job.executionObservation = { markerVerified: true, recordedEvent: 3 };
    job.result = { ...task.result, headSha: head, collectionStartedEvent: 4 };
  };
  return { state, store, controller, task, tick, finish, now, calls: () => calls, sends: () => sends };
}
const finding = text => ({ verdict: 'correct', summary: text, findings: [{ path: 'slug.js', line: 2, problem: text }] });

test('two corrections are a durable lifetime limit, including after restart', async () => {
  const w = fixture({ results: [finding('Whitespace is not trimmed'), finding('Dashes repeat'), finding('Empty input throws')] });
  await w.controller.run(); assert.equal(w.sends(), 1);
  w.finish(B); w.tick(); await w.controller.run(); assert.equal(w.sends(), 2);
  w.finish(C); w.tick(); await w.controller.run(); assert.equal(w.sends(), 2);
  assert.equal(w.task.followThrough.status, 'blocked');
  assert.match(w.task.followThrough.reason, /Two correction/);
  w.tick(); await w.controller.run(); assert.equal(w.calls(), 3);
  assert.equal(followThroughView(w.state).corrections, 2);
});

test('duplicate concurrent wakeups do not create duplicate reviews or correction fires', async () => {
  const w = fixture({ results: [finding('Whitespace is not trimmed')] });
  await Promise.all([w.controller.run(), w.controller.run(), w.controller.run()]);
  assert.equal(w.calls(), 1); assert.equal(w.sends(), 1);
  w.tick(); await w.controller.run(); assert.equal(w.calls(), 1); assert.equal(w.sends(), 1);
});

test('uncertain correction consumes its attempt and is never automatically replayed', async () => {
  const w = fixture({ results: [finding('Whitespace is not trimmed')], correct: async () => { throw new Error('timeout'); } });
  await w.controller.run(); w.tick(); await w.controller.run();
  assert.equal(w.task.followThrough.attempts.length, 1); assert.equal(w.sends(), 1);
  assert.match(w.task.followThrough.reason, /uncertain/);
});

test('provider exit must precede fresh evidence and dispatch', async () => {
  const w = fixture({ results: [finding('Whitespace is not trimmed')], observed: false });
  await w.controller.run(); assert.equal(w.sends(), 0);
  assert.equal(w.task.followThrough.status, 'waiting_for_provider_exit');
  w.task.execution = 'exited'; w.task.executionObservation = { markerVerified: true, recordedEvent: 3 };
  w.tick(); await w.controller.run(); assert.equal(w.sends(), 0);
  w.task.result.collectionStartedEvent = 4;
  w.tick(); await w.controller.run(); assert.equal(w.sends(), 1); assert.equal(w.calls(), 1);
});

test('no-progress and repeated findings stop before another correction', async () => {
  const unchanged = fixture({ results: [finding('Whitespace is not trimmed')] });
  await unchanged.controller.run(); unchanged.finish(A); unchanged.tick(); await unchanged.controller.run();
  assert.match(unchanged.task.followThrough.reason, /without a new commit/); assert.equal(unchanged.sends(), 1);
  const repeated = fixture({ results: [finding('Whitespace is not trimmed'), finding('WHITESPACE is not trimmed')] });
  await repeated.controller.run(); repeated.finish(B); repeated.tick(); await repeated.controller.run();
  assert.match(repeated.task.followThrough.reason, /finding repeated/); assert.equal(repeated.sends(), 1);
});

test('stale authority, exhausted allowance, isolation and pause block autonomous work', async () => {
  for (const mutate of [w => w.state.reservedMicros = w.state.budgetMicros, w => w.state.project.revision = 'other',
    w => w.task.followThrough.grant.expiresAt = '2026-09-20T00:00:00Z', w => w.state.paused = true,
    w => w.state.project.id = 'another-project']) {
    const w = fixture(); mutate(w); await w.controller.run(); assert.equal(w.calls(), 0); assert.equal(w.sends(), 0);
  }
});

test('uncertain review intent on restart stops instead of buying another judgment', async () => {
  const w = fixture(); w.task.followThrough.status = 'reviewing';
  await w.controller.run(); assert.equal(w.calls(), 0); assert.match(w.task.followThrough.reason, /uncertain/);
});

test('a clean reviewed head remains quiet but a new head receives a new review', async () => {
  const w = fixture(); await w.controller.run(); assert.equal(w.task.followThrough.status, 'ready_for_owner');
  w.tick(); await w.controller.run(); assert.equal(w.calls(), 1);
  w.task.result.headSha = B; w.tick(); await w.controller.run(); assert.equal(w.calls(), 2);
});

test('invalid findings and unavailable adapter cannot trigger writes', async () => {
  const w = fixture({ results: [{ ...finding('Bad'), findings: [{ path: 'secrets.txt', line: 1, problem: 'Bad' }] }] });
  await w.controller.run(); assert.equal(w.task.followThrough.status, 'blocked'); assert.equal(w.sends(), 0);
  const unavailable = fixture({ results: [finding('Bad')], correct: null });
  await unavailable.controller.run(); assert.equal(unavailable.task.followThrough.status, 'waiting_for_connection');
  assert.equal(unavailable.task.followThrough.attempts.length, 0);
});

function reader(task, options = {}) {
  let prs = 0;
  return async path => {
    if (path.includes('/files?')) return [{ filename: 'slug.js', patch: options.patch ?? '@@ -1 +1 @@\n-a\n+b' }];
    prs++;
    return { state: 'open', head: { sha: options.changed && prs > 1 ? B : A, ref: task.branch, repo: { full_name: task.spec.repository } },
      base: { sha: task.spec.baseSha, ref: 'main', repo: { full_name: task.spec.repository } }, body: task.marker };
  };
}
test('review evidence rejects a moving head, oversized patch and private disclosure', async () => {
  const w = fixture();
  const packet = await codeReviewPacket({ task: w.task, job: w.task, read: reader(w.task), now: w.now() });
  assert.match(packet.content, /slug.js/);
  await assert.rejects(codeReviewPacket({ task: w.task, job: w.task, read: reader(w.task, { changed: true }), now: w.now() }), /HEAD_CHANGED/);
  await assert.rejects(codeReviewPacket({ task: w.task, job: w.task, read: reader(w.task, { patch: 'x'.repeat(6001) }), now: w.now() }), /TOO_LARGE/);
  w.task.spec.visibility = 'private';
  await assert.rejects(codeReviewPacket({ task: w.task, job: w.task, read: reader(w.task), now: w.now() }), /DISCLOSURE/);
});

test('Eve review uses the existing request ledger and cannot accept an unmetered model result', async () => {
  const w = fixture(); w.state.model = 'anthropic/claude-opus-5';
  const input = { task: w.task, job: w.task, review: { id: 'review-synthetic' } };
  w.task.followThrough.status = 'reviewing';
  w.task.followThrough.reviews.push({ id: input.review.id, status: 'intent', headSha: A });
  let seen;
  const unmetered = createCodeReview({ store: w.store, read: reader(w.task), now: w.now, judge: async value => { seen = value; return { verdict: 'ready', summary: 'Fine', findings: [] }; } });
  assert.equal(await unmetered(input), null);
  assert.equal(seen.mode, 'coding_review'); assert.equal(w.state.requests['review-synthetic'].status, 'not_sent');
  assert.equal(codeReviewSchema.safeParse({ verdict: 'ready', summary: 'Fine', findings: [] }).success, true);
});

test('notification intents survive unknown delivery and unchanged wakeups stay quiet', async () => {
  const w = fixture(); await w.controller.run(); let sends = 0;
  const notify = () => notifyFollowThrough({ store: w.store, now: w.now, send: async () => { sends++; throw new Error('lost response'); } });
  await Promise.all([notify(), notify()]); await notify();
  assert.equal(sends, 1);
  assert.equal(Object.values(w.task.followThrough.notifications)[0].status, 'delivery_unknown');
});

test('old ready tasks do not starve a newer due task', async () => {
  const w = fixture(); await w.controller.run();
  const second = structuredClone(w.task); second.id = 'task2'; second.followThrough = {
    grant: followThroughGrant(second, w.now()), status: 'waiting_for_pr', activeJobId: 'task2', reviews: [], attempts: [], nextCheckAt: w.now() };
  w.state.coding.jobs.task2 = second; w.tick(); await w.controller.run();
  assert.equal(second.followThrough.reviews.length, 1);
});

test('review admission rechecks grant after network reads and model admission checks it again', async () => {
  const w = fixture(); w.state.model = HOSTED_MODEL; w.state.project.sources[0].exposure = 'model_allowed';
  const pending = { id: 'review-admission', status: 'intent', headSha: A };
  w.task.followThrough.status = 'reviewing'; w.task.followThrough.reviews.push(pending);
  const baseRead = reader(w.task); let calls = 0;
  const service = createCodeReview({ store: w.store, now: w.now, judge: async () => { calls++; }, read: async path => {
    const response = await baseRead(path); w.task.followThrough.grant.expiresAt = '2026-09-20T00:00:00Z'; return response;
  } });
  await assert.rejects(service({ task: w.task, job: w.task, review: pending }), /AUTHORITY_CHANGED/); assert.equal(calls, 0);
  w.task.followThrough.grant.expiresAt = '2026-09-23T00:00:00Z';
  const liveAdmission = createCodeReview({ store: w.store, now: w.now, read: reader(w.task), judge: async input => {
    w.task.followThrough.status = 'blocked';
    const transport = hostedTransport({ store: w.store, requestId: pending.id, inputDigest: digest(input), sessionId: 'synthetic-session', now: w.now,
      send: async () => { calls++; return new Response('ok'); } });
    await transport('https://ai-gateway.vercel.sh/v4/ai/language-model', { method: 'POST', headers: { 'ai-language-model-id': HOSTED_MODEL }, body: JSON.stringify({ maxOutputTokens: 2048, prompt: [{ role: 'user', content: JSON.stringify(input) }], tools: [{ type: 'function', name: 'final_output', inputSchema: { type: 'object' } }] }) });
  } });
  assert.equal(await liveAdmission({ task: w.task, job: w.task, review: pending }), null);
  assert.equal(calls, 0); assert.equal(w.state.reservedMicros, 1);
});

function correctionFixture(options = {}) {
  const w = fixture(); const f = w.task.followThrough;
  const review = { id: 'review-approved', headSha: A, status: 'completed', result: finding('Whitespace repeats') };
  const attempt = { id: 'task1-fix-1', headSha: A, status: 'intent' };
  f.reviews.push(review); f.attempts.push(attempt); f.status = 'dispatching';
  const config = { spec: w.task.spec, followThrough: true, correctionsVerified: true, verifiedUntil: '2026-09-23T00:00:00Z', token: 'synthetic-only' };
  let sends = 0;
  const coding = new HostedCoding(w.store, { config, now: w.now, read: async path => ({ ...await reader(w.task)(path), state: options.closed ? 'closed' : 'open' }),
    send: async value => { sends++; assert.equal(w.state.coding.jobs[attempt.id].dispatch, 'unknown');
      const payload = JSON.parse(value.text); assert.equal(payload.mode, 'correction'); assert.equal(payload.expectedHeadSha, A);
      assert.equal(payload.branch, w.task.branch); assert.equal(payload.prNumber, 5); assert.deepEqual(payload.allowedPaths, ['slug.js']);
      return options.unknown ? { outcome: 'unknown' } : { outcome: 'accepted', session: { id: 'session_synthetic' } }; } });
  coding.reconcile = async () => { if (options.expire) config.verifiedUntil = '2026-09-20T00:00:00Z'; return w.task; };
  return { ...w, coding, sends: () => sends, input: { task: w.task, previous: w.task, review, attempt } };
}
test('real correction adapter binds one intent to the same task PR and refuses replay', async () => {
  const w = correctionFixture(); assert.equal((await w.coding.correct(w.input)).outcome, 'accepted');
  assert.equal(w.state.coding.active, 'task1-fix-1'); assert.equal(w.state.coding.jobs['task1-fix-1'].scopeHash, w.task.scopeHash);
  await assert.rejects(w.coding.correct(w.input), /NOT_APPROVED/); assert.equal(w.sends(), 1);
});
test('real correction adapter refuses closed PRs, expired verification and another writer', async () => {
  for (const options of [{ closed: true }, { expire: true }, { competing: true }]) {
    const w = correctionFixture(options);
    if (options.competing) w.state.coding.active = 'another-writer';
    await assert.rejects(w.coding.correct(w.input), /HEAD_CHANGED|NOT_APPROVED|UNVERIFIED/); assert.equal(w.sends(), 0);
  }
});

test('a successful review reserves against the existing cumulative model allowance', async () => {
  const w = fixture(); w.state.model = HOSTED_MODEL;
  const review = { id: 'review-metered', status: 'intent', headSha: A };
  w.task.followThrough.status = 'reviewing'; w.task.followThrough.reviews.push(review);
  const judge = async input => {
    const transport = hostedTransport({ store: w.store, requestId: review.id, inputDigest: digest(input), sessionId: 'synthetic-metered', now: w.now,
      send: async () => new Response('synthetic response', { status: 200 }) });
    await transport('https://ai-gateway.vercel.sh/v4/ai/language-model', { method: 'POST', headers: { 'ai-language-model-id': HOSTED_MODEL },
      body: JSON.stringify({ maxOutputTokens: 2048, prompt: [{ role: 'user', content: JSON.stringify(input) }], tools: [{ type: 'function', name: 'final_output', inputSchema: { type: 'object' } }] }) });
    return { verdict: 'ready', summary: 'Synthetic review completed', findings: [] };
  };
  const service = createCodeReview({ store: w.store, read: reader(w.task), judge, now: w.now });
  assert.equal((await service({ task: w.task, job: w.task, review })).verdict, 'ready');
  const request = w.state.requests[review.id];
  assert.equal(request.status, 'review_completed'); assert.ok(request.provider.reservedMicros > 0);
  assert.equal(w.state.reservedMicros, 1 + request.provider.reservedMicros);
  assert.equal(w.state.budgetMicros, 10_000_000);
  await assert.rejects(service({ task: w.task, job: w.task, review }), /ADMISSION_DENIED/);
});
