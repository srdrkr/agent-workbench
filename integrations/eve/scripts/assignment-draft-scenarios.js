/**
 * Deterministic browser scenarios for assignment drafting (outcome 3).
 * The judge is held and released on signals; the application clock only moves
 * when a scenario advances it. The Routine is an in-process recorder, so a
 * "send" is observable without any network. No sleeps.
 */
import { ASSIGNMENT_PROJECT, DRAFT_CODING_SPEC, draftRepositoryReader, SUFFICIENT_REQUEST, GAP_REQUEST,
  DRAFT_OK, DRAFT_WITH_INVALID, DRAFT_GAP } from '../test/assignment-draft-fixture.js';

// Ten minutes before the synthetic brief expires: long enough for every scenario,
// short enough that the stale scenario can expire the brief while the 15-minute
// coding review itself is still valid.
export const ASSIGNMENT_FIXTURE_OPTIONS = Object.freeze({
  project: ASSIGNMENT_PROJECT,
  clockStart: '2026-09-25T23:50:00.000Z',
  coding: { spec: DRAFT_CODING_SPEC, read: draftRepositoryReader, verifiedUntil: '2026-10-25T00:00:00.000Z' },
});

function recorder() {
  const assertions = [];
  return {
    assertions,
    pass: (name, observed) => assertions.push({ name, ok: true, observed }),
    fail: (name, observed) => { assertions.push({ name, ok: false, observed }); throw new Error(`${name}: ${typeof observed === 'string' ? observed : JSON.stringify(observed)}`); },
  };
}
const check = (r, name, ok, observed) => (ok ? r.pass(name, observed) : r.fail(name, observed));

/** Count browser calls that could dispatch coding. */
function watchCoding(page) {
  const calls = [];
  page.on('request', req => { const u = new URL(req.url()); if (u.pathname.startsWith('/api/steward/coding/')) calls.push(u.pathname); });
  return { get approves() { return calls.filter(p => p === '/api/steward/coding/approve').length; }, calls };
}
async function state(page) { return page.evaluate(async () => (await fetch('/api/steward/state', { credentials: 'same-origin' })).json()); }
async function probeApprove(page, body) {
  return page.evaluate(async b => { const r = await fetch('/api/steward/coding/approve', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() }; }, body);
}

async function askForDraft(page, fixture, message, response) {
  fixture.judge.hold();
  await page.getByLabel('Request to Eve').fill(message);
  await page.getByLabel(/Draft a coding assignment I can review and edit/).check();
  const called = fixture.judge.waitUntilCalled({ timeoutMs: 20000, atLeast: fixture.judge.calls + 1 });
  await page.getByRole('button', { name: 'Ask Eve' }).click();
  await called;
  const mode = fixture.judge.lastInput?.mode;
  fixture.judge.release(response);
  return mode;
}
async function openDraft(page) {
  const button = page.getByRole('button', { name: 'Review Eve’s draft assignment' });
  await button.waitFor({ timeout: 20000 });
  await button.click();
  await page.getByRole('heading', { name: 'Prepare a coding assignment' }).waitFor({ timeout: 10000 });
}
const field = (page, label) => page.getByLabel(label);
const OBJECTIVE = 'What should change?';
const ACCEPTANCE = 'What will count as done?';
const PATHS = /Files Claude may change/;
async function prepare(page) {
  await page.getByRole('button', { name: 'Prepare exact review' }).click();
  await page.getByRole('heading', { name: 'Approve one coding assignment' }).waitFor({ timeout: 20000 });
}

export async function scenarioDraftEditApprove({ fixture, page, shot }) {
  const r = recorder(); const watch = watchCoding(page);
  const mode = await askForDraft(page, fixture, SUFFICIENT_REQUEST, DRAFT_OK);
  check(r, 'single-judge-call-in-draft-mode', mode === 'assignment_draft' && fixture.judge.calls === 1, { mode, calls: fixture.judge.calls });
  await page.getByRole('button', { name: 'Review Eve’s draft assignment' }).waitFor({ timeout: 20000 });
  const summary = await page.locator('[data-draft-summary]').first().textContent();
  check(r, 'draft-summary-on-plan', /2 file\(s\) named in the approved brief\. Reviewing or editing it sends nothing\./.test(summary), summary);
  await shot('05-draft-ready');
  await openDraft(page);
  const original = (await page.locator('[data-original-outcome]').textContent()).trim();
  check(r, 'original-outcome-verbatim', original === SUFFICIENT_REQUEST, original);
  const objective = await field(page, OBJECTIVE).inputValue();
  check(r, 'objective-starts-with-outcome-and-keeps-context', objective.startsWith(`${SUFFICIENT_REQUEST}\n`) && ASSIGNMENT_PROJECT.sources.every(s => objective.includes(s.content)), objective.slice(0, 160));
  const paths = await field(page, PATHS).inputValue();
  check(r, 'prefilled-scope-is-context-verified', paths === 'src/slug.js\ntest/slug.test.js', paths);
  const acceptance = await field(page, ACCEPTANCE).inputValue();
  check(r, 'acceptance-and-verification-prefilled', /^Acceptance examples:\n1\. /.test(acceptance) && /Verification steps:\n1\. Run node --test/.test(acceptance), acceptance);
  check(r, 'outcome-status-included', /included unchanged/.test(await page.locator('[data-outcome-status]').textContent()), 'included');
  await shot('06-draft-form');
  const firstEdit = `${acceptance}\n3. Confirm a title of only spaces yields an empty slug`;
  await field(page, ACCEPTANCE).fill(firstEdit);
  await prepare(page);
  check(r, 'review-provenance-edited-outcome-intact', /Drafted by Eve, edited by you\. Your original outcome is included unchanged\./.test(await page.locator('[data-review-provenance]').textContent()), 'edited+intact');
  check(r, 'no-dispatch-after-prepare', fixture.codingSends.length === 0 && watch.approves === 0, { sends: fixture.codingSends.length, approves: watch.approves });
  const before = await state(page);
  const firstRecord = before.requests.find(x => x.status === 'awaiting_approval' && x.source === 'authenticated_owner_assignment');
  const firstReview = { requestId: firstRecord.id, proposalHash: firstRecord.proposalHash, reviewHash: firstRecord.codingReview.reviewHash };
  await page.getByRole('button', { name: 'Edit assignment' }).click();
  await page.locator('[data-editing-prepared]').waitFor({ timeout: 10000 });
  const finalAcceptance = `${firstEdit}\n4. Confirm "Ünïcode  Title" keeps its letters`;
  await field(page, ACCEPTANCE).fill(finalAcceptance);
  await prepare(page);
  const after = await state(page);
  const retired = after.requests.find(x => x.id === firstReview.requestId);
  check(r, 'edit-supersedes-earlier-assignment', retired?.status === 'superseded' && !retired.codingReview && Boolean(retired.supersededBy), { status: retired?.status, supersededBy: retired?.supersededBy });
  const probe = await probeApprove(page, firstReview);
  check(r, 'earlier-approval-fingerprint-rejected', probe.status === 409 && probe.body.error === 'CODING_APPROVAL_MISMATCH', probe);
  check(r, 'no-dispatch-during-review-and-edit', fixture.codingSends.length === 0 && watch.approves === 1 && fixture.judge.calls === 1,
    { sends: fixture.codingSends.length, approveCalls: watch.approves, note: 'the single approve call is the rejected stale-fingerprint probe', judgeCalls: fixture.judge.calls });
  await shot('07-edited-review');
  await page.getByRole('button', { name: 'Approve and start Claude' }).click();
  await page.getByText('Sent to Claude · awaiting progress').first().waitFor({ timeout: 20000 });
  check(r, 'exactly-one-dispatch-after-exact-approval', fixture.codingSends.length === 1, fixture.codingSends.length);
  const sent = JSON.parse(fixture.codingSends[0].text);
  check(r, 'dispatched-equals-approved-edit', sent.acceptance === finalAcceptance && sent.objective === objective && sent.allowedPaths.join('\n') === paths,
    { objectiveStart: sent.objective.slice(0, 80), acceptanceEnd: sent.acceptance.slice(-60), allowedPaths: sent.allowedPaths });
  await shot('08-approved-dispatched');
  return r.assertions;
}

export async function scenarioDraftGap({ fixture, page, shot }) {
  const r = recorder(); const watch = watchCoding(page);
  await askForDraft(page, fixture, GAP_REQUEST, DRAFT_GAP);
  await page.getByText(DRAFT_GAP.question).waitFor({ timeout: 20000 });
  check(r, 'one-focused-question-shown', (DRAFT_GAP.question.match(/\?/g) ?? []).length === 1, DRAFT_GAP.question);
  check(r, 'needs-context-label', await page.getByText('Needs your context', { exact: true }).count() >= 1, 'Needs your context');
  const draftButtons = await page.getByRole('button', { name: 'Review Eve’s draft assignment' }).count();
  const planButtons = await page.getByRole('button', { name: 'Turn this plan into an assignment' }).count();
  check(r, 'no-draft-offered-for-gap', draftButtons === 0 && planButtons === 0, { draftButtons, planButtons });
  check(r, 'no-dispatch-for-gap', fixture.codingSends.length === 0 && watch.calls.length === 0, { sends: fixture.codingSends.length, codingCalls: watch.calls });
  await shot('09-gap-question');
  return r.assertions;
}

export async function scenarioDraftInvalidPath({ fixture, page, shot }) {
  const r = recorder();
  await askForDraft(page, fixture, SUFFICIENT_REQUEST, DRAFT_WITH_INVALID);
  await page.getByRole('button', { name: 'Review Eve’s draft assignment' }).waitFor({ timeout: 20000 });
  const summary = await page.locator('[data-draft-summary]').first().textContent();
  check(r, 'flag-count-on-plan', /2 file\(s\) named in the approved brief; 3 suggestion\(s\) flagged/.test(summary), summary);
  await openDraft(page);
  const flags = await page.locator('[data-draft-flags] li').allTextContents();
  check(r, 'unnamed-path-flagged', flags.some(f => f.startsWith('src/links/format.js: not named in the approved brief')), flags);
  check(r, 'invalid-path-flagged', flags.some(f => f.startsWith('../secrets.env: not an exact relative file path')), flags);
  check(r, 'unknown-source-flagged', flags.some(f => f.startsWith('roadmap: not a source in the approved brief')), flags);
  const paths = await field(page, PATHS).inputValue();
  check(r, 'flagged-paths-not-prefilled', paths === 'src/slug.js\ntest/slug.test.js', paths);
  check(r, 'no-dispatch-for-invalid-draft', fixture.codingSends.length === 0, fixture.codingSends.length);
  await shot('10-flagged-paths');
  return r.assertions;
}

export async function scenarioDraftStale({ fixture, page, shot }) {
  const r = recorder();
  await askForDraft(page, fixture, SUFFICIENT_REQUEST, DRAFT_OK);
  await openDraft(page);
  await prepare(page);
  const s = await state(page);
  const rec = s.requests.find(x => x.status === 'awaiting_approval' && x.source === 'authenticated_owner_assignment');
  const review = { requestId: rec.id, proposalHash: rec.proposalHash, reviewHash: rec.codingReview.reviewHash };
  const before = fixture.now();
  const at = fixture.advanceClock(11 * 60_000);
  check(r, 'review-itself-still-unexpired', Date.parse(rec.codingReview.expiresAt) > Date.parse(at) && Date.parse(ASSIGNMENT_PROJECT.sources[0].expiresAt) <= Date.parse(at),
    { before, after: at, reviewExpiresAt: rec.codingReview.expiresAt, briefExpiresAt: ASSIGNMENT_PROJECT.sources[0].expiresAt });
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await page.locator('[data-stale-approval]').waitFor({ timeout: 10000 });
  check(r, 'approve-disabled-when-stale', await page.getByRole('button', { name: 'Approve and start Claude' }).isDisabled(), 'disabled');
  const probe = await probeApprove(page, review);
  check(r, 'server-rejects-stale-approval', probe.status === 409 && probe.body.error === 'CODING_APPROVAL_MISMATCH', probe);
  check(r, 'no-dispatch-when-stale', fixture.codingSends.length === 0, fixture.codingSends.length);
  await shot('11-stale-blocked');
  return r.assertions;
}

export const ASSIGNMENT_SCENARIOS = [
  { name: 'assignment-draft-edit-approve', run: scenarioDraftEditApprove, failureShot: '05-failure' },
  { name: 'assignment-draft-gap', run: scenarioDraftGap, failureShot: '09-failure' },
  { name: 'assignment-draft-invalid-path', run: scenarioDraftInvalidPath, failureShot: '10-failure' },
  { name: 'assignment-draft-stale', run: scenarioDraftStale, failureShot: '11-failure' },
];
