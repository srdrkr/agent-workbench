import test from 'node:test';
import assert from 'node:assert/strict';
import { statusSummary, STATUS_SUMMARY_LIMIT } from '../shared/status-summary.js';

const LINK = 'https://steward.example.com';
const REVISION = 'rev-current';
const base = () => ({
  project: { id: 'synthetic', name: 'Synthetic project', revision: REVISION }, paused: false, contextFresh: true,
  continuationProblem: null, continuationAvailable: false, providerAttempts: 1, maxProviderAttempts: 5,
  requests: [], commitments: [], codingJobs: [], monitor: null,
  progress: { notes: [], priority: null, commitments: [], jobs: [] },
});
const job = (extra = {}) => ({ id: 'job-1', spec: { objective: 'Add a status line' }, dispatch: 'accepted', execution: 'unobserved',
  stopRequested: false, dispatchStartedAt: '2026-09-20T10:00:00.000Z', result: null, ...extra });
const parts = text => Object.fromEntries(text.split('\n')[0].split(/\. (?=Blocker: |Next: )/).map(p => p.split(': ')).map(([k, ...v]) => [k, v.join(': ').replace(/\.$/, '')]));

test('empty workspace states the absence of progress and a safe next step', () => {
  const text = statusSummary(base());
  assert.equal(text, 'Progress: no recorded progress yet. Blocker: none recorded. Next: ask Eve for the next useful step.');
  assert.ok(text.length <= STATUS_SUMMARY_LIMIT);
  assert.equal(statusSummary(null), text);
  assert.equal(statusSummary({ project: { name: 'Minimal' }, requests: [], commitments: [], providerAttempts: 0, maxProviderAttempts: 5 }), text);
});

test('tested draft PR is reported without implying the Claude session ended', () => {
  const view = base();
  view.progress.jobs = [job({ result: { result: 'tested_draft_pr', prUrl: 'https://github.com/example/repo/pull/7', observedAt: '2026-09-20T11:00:00.000Z' } })];
  const text = statusSummary(view, { link: LINK });
  assert.deepEqual(parts(text), { Progress: 'draft PR passed required checks; Claude finish unconfirmed', Blocker: 'none recorded', Next: 'confirm Claude finished, then review the draft PR' });
  assert.ok(text.endsWith(`\n${LINK}`));
  assert.ok(text.length <= STATUS_SUMMARY_LIMIT);
  assert.doesNotMatch(text, /merged|deployed|complete/i);
});

test('closed run with a merged PR does not claim deployment', () => {
  const view = base();
  view.codingJobs = [job({ releasedAt: '2026-09-20T12:00:00.000Z', execution: 'exited', result: { result: 'merged_pr', observedAt: '2026-09-20T11:30:00.000Z' } })];
  view.progress = undefined;
  const p = parts(statusSummary(view));
  assert.equal(p.Progress, 'PR merged; deployment not verified');
  assert.equal(p.Next, 'ask Eve for the next useful step');
});

test('unconfirmed start is a blocker, not progress', () => {
  const view = base();
  view.progress.jobs = [job({ dispatch: 'timeout' })];
  const p = parts(statusSummary(view));
  assert.equal(p.Progress, 'Claude start unconfirmed for: Add a status line');
  assert.equal(p.Blocker, 'coding start unconfirmed; check Claude first');
  assert.equal(p.Next, 'check Claude, then confirm or close the run');
});

test('blockers take precedence in a fixed order with a matching next action', () => {
  const cases = [
    [v => { v.continuationProblem = 'CONTINUATION_SOURCE_EXPIRED'; }, 'reviewed coding result expired', 'review continuation in the web app'],
    [v => { v.paused = true; }, 'new model requests paused', 'resume requests when ready'],
    [v => { v.contextFresh = false; }, 'project brief expired', 'update the project brief'],
    [v => { v.providerAttempts = 5; }, 'model allowance used up', 'review the pilot allowance'],
    [v => { v.requests = [{ id: 'r', status: 'held', contextRevision: REVISION }]; }, 'a held model attempt needs review', 'review the held attempt'],
    [v => { v.monitor = { lastError: 'GitHub check unavailable; prior progress retained.' }; }, 'GitHub check unavailable; older result shown', 'ask Eve for the next useful step'],
    [v => { v.requests = [{ id: 'r', status: 'thinking', contextRevision: REVISION }]; }, 'waiting for Eve', 'wait for Eve, then review the proposal'],
  ];
  for (const [apply, blocker, next] of cases) {
    const view = base(); apply(view);
    const p = parts(statusSummary(view));
    assert.equal(p.Blocker, blocker); assert.equal(p.Next, next);
  }
});

test('owner-reported completion and pending decisions use recorded titles only', () => {
  const view = base();
  view.progress.commitments = [
    { id: 'c1', title: 'Write the onboarding email', approvedAt: '2026-09-18T00:00:00.000Z', completedAt: '2026-09-19T00:00:00.000Z' },
    { id: 'c2', title: 'Ship the pricing page', approvedAt: '2026-09-19T00:00:00.000Z' },
  ];
  view.requests = [
    { id: 'old', status: 'awaiting_approval', contextRevision: 'rev-old', proposal: { kind: 'commitment', title: 'Historical proposal' } },
    { id: 'new', status: 'awaiting_approval', contextRevision: REVISION, proposal: { kind: 'coding', title: 'Add the status line' } },
  ];
  const p = parts(statusSummary(view));
  assert.equal(p.Progress, 'owner reported done: Write the onboarding email');
  assert.equal(p.Next, 'review the coding assignment: Add the status line');
  view.requests = [];
  assert.equal(parts(statusSummary(view)).Next, 'work on: Ship the pricing page');
});

test('long titles, notes and links stay within 280 characters with the link intact', () => {
  const view = base();
  const long = 'A very long recorded title that keeps going far beyond anything a short status could carry '.repeat(4);
  view.progress.notes = [{ id: 'n', kind: 'note', text: long, at: '2026-09-19T00:00:00.000Z' }];
  view.requests = [{ id: 'r', status: 'awaiting_approval', contextRevision: REVISION, proposal: { kind: 'commitment', title: long } }];
  for (const link of ['', LINK, `${LINK}/${'p'.repeat(120)}`]) {
    const text = statusSummary(view, { link });
    assert.ok(text.length <= STATUS_SUMMARY_LIMIT, `${text.length} > ${STATUS_SUMMARY_LIMIT}`);
    if (link) assert.ok(text.endsWith(`\n${link}`));
    assert.match(text, /^Progress: latest note: .+…\. Blocker: none recorded\. Next: decide on the proposal: .+…\./);
  }
});

test('the same input gives the same text on both surfaces', () => {
  const view = base();
  view.progress.jobs = [job({ result: { result: 'branch_without_pr', observedAt: '2026-09-20T11:00:00.000Z' } })];
  const web = statusSummary(view);
  const telegram = statusSummary(view, { link: LINK });
  assert.equal(telegram, `${web}\n${LINK}`);
  assert.equal(statusSummary(view), web);
});
