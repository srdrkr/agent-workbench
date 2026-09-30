/**
 * Deterministic browser scenarios for assignment drafting (outcome 3).
 * The judge is held and released on signals; the application clock only moves
 * when a scenario advances it. The Routine is an in-process recorder, so a
 * "send" is observable without any network. No sleeps.
 */
import { ASSIGNMENT_PROJECT, DRAFT_CODING_SPEC, draftRepositoryReader, SUFFICIENT_REQUEST, GAP_REQUEST,
  DRAFT_OK, DRAFT_WITH_INVALID, DRAFT_GAP, DRAFT_NO_SCOPE } from '../test/assignment-draft-fixture.js';

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

async function askForDraft(page, fixture, message, response, { draftMode = true } = {}) {
  fixture.judge.hold();
  await page.getByLabel('Request to Eve').fill(message);
  if (draftMode) await page.getByLabel(/Draft a coding assignment I can review and edit/).check();
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
  await page.locator('#assignment').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('heading', { name: 'Approve one coding assignment' }).waitFor({ timeout: 10000 });
  check(r, 'cancel-edit-retains-original-review', (await state(page)).requests.find(x => x.id === firstReview.requestId)?.codingReview?.reviewHash === firstReview.reviewHash, 'same review');
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
  await page.getByText(DRAFT_GAP.question, { exact: true }).waitFor({ timeout: 20000 });
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

async function scenarioManualDraft({ fixture, page, shot, largeProgress = false }) {
  const r = recorder();
  let request = SUFFICIENT_REQUEST;
  let response = DRAFT_NO_SCOPE;
  if (largeProgress) {
    const revision = (await fixture.store.read()).project.revision;
    for (let i = 0; i < 3; i++) await fixture.steward.saveNote({ text: `Synthetic note ${i}: ${'x'.repeat(900)}`, kind: 'note', expectedContextRevision: revision });
    await fixture.steward.saveNote({ text: `Synthetic priority: ${'x'.repeat(900)}`, kind: 'priority', expectedContextRevision: revision });
    request += `\nSynthetic detail: ${'x'.repeat(1700)}`;
    response = { ...DRAFT_OK, citations: [...DRAFT_OK.citations, 'project-progress'] };
  }
  await askForDraft(page, fixture, request, response);
  await page.getByRole('button', { name: 'Prepare assignment manually', exact: true }).waitFor({ timeout: 20000 });
  check(r, 'manual-next-step', /prepare the assignment manually/.test(await page.locator('p.summary').innerText()), 'manual preparation');
  const record = (await state(page)).requests.find(x => x.draftFeedback);
  check(r, 'gap-without-unusable-prefill', !record.assignmentDraft && (largeProgress ? /^Which referenced context/ : /^Which existing files/).test(record.draftFeedback.gap), record.draftFeedback.gap);
  await page.getByRole('button', { name: 'Prepare assignment manually', exact: true }).click();
  await page.locator('[data-manual-draft]').waitFor({ timeout: 10000 });
  check(r, 'manual-form-retains-outcome', await field(page, OBJECTIVE).inputValue() === request, 'verbatim');
  check(r, 'manual-editor-original-outcome', await page.locator('[data-original-outcome]').textContent() === request, 'verbatim');
  check(r, 'manual-editor-label-included', /included unchanged/.test(await page.locator('[data-outcome-status]').textContent()), 'included');
  check(r, 'manual-scope-not-invented', await field(page, PATHS).inputValue() === '' && await field(page, ACCEPTANCE).inputValue() === '', 'owner supplies scope and acceptance');
  check(r, 'all-context-available-to-owner', await page.locator('[data-manual-draft] details').count() === record.contextSnapshot.sources.length, 'all snapshot sources');
  await field(page, OBJECTIVE).fill(`${request}\nOwner selected context: normalize whitespace only.`);
  await field(page, ACCEPTANCE).fill('Leading, repeated and trailing spaces normalize. Existing node tests pass.');
  await field(page, PATHS).fill('src/slug.js');
  await prepare(page);
  check(r, 'manual-preparation-needs-no-new-judge-or-dispatch', fixture.judge.calls === 1 && fixture.codingSends.length === 0, { judge: fixture.judge.calls, sends: fixture.codingSends.length });
  check(r, 'manual-review-label-included-without-draft-attribution', await page.locator('[data-review-provenance]').textContent() === 'Your original outcome is included unchanged.', 'owner-prepared');
  await page.getByRole('button', { name: 'Edit assignment', exact: true }).click();
  check(r, 'manual-edit-retains-original-outcome', await page.locator('[data-original-outcome]').textContent() === request, 'verbatim');
  await field(page, OBJECTIVE).fill(`Choose a different outcome.\nApproved context: ${request}`);
  check(r, 'manual-editor-label-edited', /You edited your original outcome/.test(await page.locator('[data-outcome-status]').textContent()), 'edited');
  await prepare(page);
  check(r, 'manual-review-label-edited-without-draft-attribution', await page.locator('[data-review-provenance]').textContent() === 'Your original outcome was edited.', 'edited');
  check(r, 'manual-edit-needs-no-new-judge-or-dispatch', fixture.judge.calls === 1 && fixture.codingSends.length === 0, { judge: fixture.judge.calls, sends: fixture.codingSends.length });
  await shot(largeProgress ? '17-large-context-manual-review' : '16-missing-scope-manual-review');
  return r.assertions;
}

export async function scenarioManualPlan({ fixture, page, shot }) {
  const r = recorder();
  const { draft, ...plan } = DRAFT_OK;
  const mode = await askForDraft(page, fixture, SUFFICIENT_REQUEST, plan, { draftMode: false });
  check(r, 'ordinary-plan-keeps-ordinary-judgment', mode === undefined && fixture.judge.calls === 1, { mode, calls: fixture.judge.calls });
  await page.getByRole('button', { name: 'Turn this plan into an assignment', exact: true }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Turn this plan into an assignment', exact: true }).click();
  check(r, 'ordinary-plan-prefills-owner-request-not-title', await field(page, OBJECTIVE).inputValue() === SUFFICIENT_REQUEST && SUFFICIENT_REQUEST !== plan.title, 'verbatim');
  check(r, 'ordinary-plan-original-outcome-visible', await page.locator('[data-original-outcome]').textContent() === SUFFICIENT_REQUEST, 'verbatim');
  check(r, 'ordinary-plan-outcome-included', /included unchanged/.test(await page.locator('[data-outcome-status]').textContent()), 'included');
  await field(page, PATHS).fill('src/slug.js');
  await prepare(page);
  check(r, 'ordinary-plan-review-has-no-draft-attribution', await page.locator('[data-review-provenance]').textContent() === 'Your original outcome is included unchanged.', 'owner-prepared');
  await shot('18-manual-plan-review');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Prepare a coding assignment', exact: true }).click();
  check(r, 'unlinked-assignment-does-not-claim-outcome', await page.locator('[data-original-outcome]').count() === 0 && await page.locator('[data-outcome-status]').count() === 0, 'unknown');
  check(r, 'manual-plan-needs-no-extra-judge-or-dispatch', fixture.judge.calls === 1 && fixture.codingSends.length === 0, { judge: fixture.judge.calls, sends: fixture.codingSends.length });
  return r.assertions;
}

export const ASSIGNMENT_SCENARIOS = [
  { name: 'assignment-manual-plan', run: scenarioManualPlan, failureShot: '18-failure' },
  { name: 'assignment-draft-edit-approve', run: scenarioDraftEditApprove, failureShot: '05-failure' },
  { name: 'assignment-draft-gap', run: scenarioDraftGap, failureShot: '09-failure' },
  { name: 'assignment-draft-invalid-path', run: scenarioDraftInvalidPath, failureShot: '10-failure' },
  { name: 'assignment-draft-stale', run: scenarioDraftStale, failureShot: '11-failure' },
  { name: 'assignment-draft-manual-scope', run: args => scenarioManualDraft(args), failureShot: '16-failure' },
  { name: 'assignment-draft-manual-context', run: args => scenarioManualDraft({ ...args, largeProgress: true }), failureShot: '17-failure' },
];
