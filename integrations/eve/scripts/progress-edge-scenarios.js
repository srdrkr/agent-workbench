import { PENDING_REQUEST_KEY } from '../app/utils/pending-request.js';

export async function scenarioLostSubmission({ fixture, page, kit, login }) {
  fixture.judge.release();
  await login(page, fixture);
  let statusAvailable = true; let mode = 'lost-response'; const sent = [];
  await page.route('**/api/steward/state', route => statusAvailable ? route.fallback()
    : route.fulfill({ status: 502, contentType: 'text/html', body: '<p>Synthetic unavailable response</p>' }));
  await page.route('**/api/steward/propose', async route => {
    sent.push(route.request().postDataJSON());
    if (mode === 'lost-response') {
      await route.fetch(); statusAvailable = false; mode = 'pass';
      await route.fulfill({ status: 502, contentType: 'text/html', body: '<p>Synthetic lost response</p>' });
    } else if (mode === 'not-delivered') { mode = 'pass'; await route.abort('failed'); }
    else await route.fallback();
  });
  await page.getByLabel('Request to Eve').fill('Synthetic: choose the next useful step.');
  await page.getByRole('button', { name: 'Ask Eve', exact: true }).click();
  await page.getByText('Submission outcome unknown', { exact: true }).waitFor({ timeout: 20000 });
  if (!await page.getByRole('button', { name: 'Ask Eve', exact: true }).isDisabled()) kit.fail('unknown-submission-allows-new-request', 'Ask Eve enabled');
  if (!/outcome unknown/.test(await page.locator('p.summary').innerText())) kit.fail('unknown-submission-summary', 'summary lacks uncertainty');
  if (fixture.judge.calls !== 1) kit.fail('lost-response-call-count', String(fixture.judge.calls));
  const receipt = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), PENDING_REQUEST_KEY);
  if (receipt?.id !== sent[0].requestId) kit.fail('lost-response-id-not-saved', 'saved ID mismatch');
  kit.pass('lost-response-and-refresh-retain-unknown-submission', { calls: fixture.judge.calls, idSaved: true });

  statusAvailable = true;
  await page.getByRole('button', { name: 'Check saved submission', exact: true }).click();
  await page.getByRole('heading', { name: 'Confirm the normalization priority' }).waitFor({ timeout: 20000 });
  if (await page.getByText('Submission outcome unknown', { exact: true }).count()) kit.fail('found-submission-still-unknown', 'marker remains');
  if (fixture.judge.calls !== 1) kit.fail('refresh-resent-submission', String(fixture.judge.calls));
  kit.pass('status-read-reconciles-without-resending', { calls: fixture.judge.calls });

  // A request that never reached the server stays available under the same ID,
  // including after reload. Retrying it still uses real server idempotency.
  mode = 'not-delivered';
  await page.getByLabel('Request to Eve').fill('Synthetic: choose the next step after that.');
  await page.getByRole('button', { name: 'Ask Eve', exact: true }).click();
  await page.getByRole('button', { name: 'Retry saved request', exact: true }).waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Retry saved request', exact: true }).waitFor({ timeout: 20000 });
  // The original can arrive after the status read but before its explicit retry.
  fixture.judge.hold();
  const underway = fixture.steward.propose(sent[1]);
  await fixture.judge.waitUntilCalled({ atLeast: 2, timeoutMs: 20000 });
  await page.getByRole('button', { name: 'Retry saved request', exact: true }).click();
  await page.getByText('Eve is still working on your saved request. You do not need to send it again.', { exact: true }).waitFor({ timeout: 20000 });
  fixture.judge.release(); await underway;
  await page.waitForFunction(() => [...document.querySelectorAll('article.decision h3')].filter(el => el.textContent === 'Confirm the normalization priority').length === 2, null, { timeout: 20000 });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  if (sent.length !== 3 || sent[1].requestId !== sent[2].requestId || sent[1].message !== sent[2].message) kit.fail('saved-retry-changed-request', JSON.stringify(sent.map(s => s.requestId)));
  if (fixture.judge.calls !== 2) kit.fail('saved-retry-call-count', String(fixture.judge.calls));
  // Replay the now-completed request using the same payload; it must not call
  // the judge or reserve allowance a second time.
  const before = (await fixture.store.read()).reservedMicros;
  await page.evaluate(async body => {
    const r = await fetch('/api/steward/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('Synthetic idempotency replay failed');
  }, sent[2]);
  if (fixture.judge.calls !== 2 || (await fixture.store.read()).reservedMicros !== before) kit.fail('completed-id-replay-called-model', 'call or allowance changed');
  kit.pass('saved-id-survives-reload-and-retry-is-idempotent', { calls: fixture.judge.calls, reservationRetained: true });

  // A different tab can start work after this tab's last state read. A definite
  // refusal must expose that work, not invent a second uncertain submission.
  fixture.judge.hold();
  const other = fixture.steward.propose({ ...sent[2], requestId: 'another-tab-request' });
  await fixture.judge.waitUntilCalled({ atLeast: 3, timeoutMs: 20000 });
  await page.getByLabel('Request to Eve').fill('Synthetic: refused while another request runs.');
  await page.getByRole('button', { name: 'Ask Eve', exact: true }).click();
  await page.getByText('A prior request needs review before another can run.', { exact: true }).first().waitFor({ timeout: 20000 });
  if (await page.getByText('Submission outcome unknown', { exact: true }).count()) kit.fail('definite-refusal-shown-as-unknown', 'unknown marker remains');
  if (await page.evaluate(key => sessionStorage.getItem(key), PENDING_REQUEST_KEY)) kit.fail('definite-refusal-kept-receipt', 'receipt remains');
  fixture.judge.release(); await other;
  kit.pass('definite-refusal-shows-existing-work', { calls: fixture.judge.calls });
  return kit.assertions;
}

export async function scenarioRecoveryStatusEdges({ fixture, page, kit, login }) {
  const { reviewId } = await fixture.prepareHeldReview('rate_limited');
  // Retain the real transport outcome, projecting it as an ordinary proposal
  // so the proposal retry control can be exercised without a live provider.
  await fixture.store.change(s => {
    const r = s.requests[reviewId]; delete r.purpose;
    r.provider.rejection.retryAfter = { kind: 'seconds', seconds: 600 };
  });
  await login(page, fixture);
  const retry = page.getByRole('button', { name: 'Retry this request once', exact: true });
  await retry.waitFor({ timeout: 20000 });
  if (!await retry.isDisabled()) kit.fail('retry-wait-button-enabled', 'Retry-After not enforced in UI');
  if (!/Next: operator:/.test(await page.locator('p.summary').innerText())) kit.fail('retry-wait-summary', 'wrong next step');
  const calls = JSON.stringify(fixture.modelCalls());
  await fixture.store.change(s => { s.requests[reviewId].provider.rejection.retryAfter.seconds = 0; });
  // Held-only states must refresh without an owner click when the wait ends.
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Retry this request once' && !b.disabled), null, { timeout: 15000 });
  await fixture.store.change(s => { s.budgetMicros = s.reservedMicros; });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Retry this request once' && b.disabled), null, { timeout: 15000 });
  if (!await retry.isDisabled()) kit.fail('exhausted-allowance-retry-enabled', 'Retry enabled at dollar limit');
  kit.pass('retry-controls-follow-wait-and-allowance', { waitRefreshed: true, allowanceBlocked: true });

  await fixture.store.change(s => {
    const r = s.requests[reviewId]; r.status = 'thinking'; r.purpose = 'coding_review';
    r.createdAt = new Date().toISOString(); s.budgetMicros = 1_000_000;
  });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByText('Review in progress', { exact: true }).waitFor({ timeout: 20000 });
  for (const selector of ['p.summary', 'section.ask p.notice', 'article.decision']) {
    if (!/reviewing the pull request/.test(await page.locator(selector).first().innerText())) kit.fail('automatic-review-wording', selector);
  }
  await fixture.store.change(s => { s.requests[reviewId].createdAt = new Date(Date.now() - 10 * 60000).toISOString(); });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByText('Review stalled', { exact: true }).waitFor({ timeout: 20000 });
  if (!/State: Blocked/.test(await page.locator('p.summary').innerText()) || !/stalled request; do not resend/.test(await page.locator('section.ask p.notice').innerText())) kit.fail('stalled-surfaces-disagree', 'missing blocked/stalled notice');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  if (JSON.stringify(fixture.modelCalls()) !== calls) kit.fail('status-reads-called-model', JSON.stringify(fixture.modelCalls()));
  kit.pass('stalled-and-automatic-review-surfaces-agree-without-model-calls', fixture.modelCalls());
  return kit.assertions;
}

export async function scenarioTerminalFailure({ fixture, page, kit, login, screenshot }) {
  const { reviewId } = await fixture.prepareHeldReview('unverified');
  await fixture.store.change(s => {
    const r = s.requests[reviewId]; delete r.purpose; r.mode = 'assignment_draft'; r.provider.sessionId = 'wrun_synthetic_terminal';
  });
  let reads = 0;
  fixture.steward.observeSession = async ({ sessionId }) => {
    reads++;
    return { source: 'eve_session_stream', sessionId, terminalAt: (await fixture.store.read()).requests[reviewId].completedAt,
      code: 'MODEL_SELECTION_FAILED', reason: 'JUDGE_STEP_LIMIT', eventCount: 8 };
  };
  const before = await fixture.store.read(); const calls = JSON.stringify(fixture.modelCalls());
  await login(page, fixture);
  await page.getByRole('button', { name: 'Check existing Eve session', exact: true }).click();
  await page.getByText('Confirmed terminal judgment failure', { exact: true }).waitFor({ timeout: 20000 });
  if (!/JUDGE_STEP_LIMIT/.test(await page.locator('[data-recovery-case="terminal_failure"]').innerText())) kit.fail('terminal-diagnostic-missing', 'expected allowlisted diagnostic');
  await page.getByRole('button', { name: 'Acknowledge failed judgment', exact: true }).click();
  await page.getByText('Failed judgment acknowledged · history kept', { exact: true }).waitFor({ timeout: 20000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Failed judgment acknowledged · history kept', { exact: true }).waitFor({ timeout: 20000 });
  const after = await fixture.store.read();
  if (reads !== 2 || JSON.stringify(fixture.modelCalls()) !== calls) kit.fail('terminal-recovery-called-model', 'unexpected model call or missing recheck');
  if (JSON.stringify(before.requests[reviewId].provider) !== JSON.stringify(after.requests[reviewId].provider)
    || before.requests[reviewId].message !== after.requests[reviewId].message || before.reservedMicros !== after.reservedMicros) kit.fail('terminal-recovery-lost-history', 'changed input/receipt/reservation');
  if (!/start a fresh request/.test(await page.locator('p.summary').innerText())) kit.fail('terminal-recovery-next-step', 'wrong summary');
  await screenshot(page);
  kit.pass('terminal-failure-observed-rechecked-and-retained', { reads, historyRetained: true, noModelCall: true });
  return kit.assertions;
}


export async function scenarioCompletedReviewHistory({ fixture, page, kit, login, screenshot }) {
  const { reviewId } = await fixture.prepareHeldReview('rate_limited');
  const record = (await fixture.steward.view()).requests.find(r => r.id === reviewId);
  await fixture.steward.acknowledgeRejectedReview({ requestId: reviewId, acknowledgeHash: record.recovery.acknowledgeHash });
  await fixture.store.change(s => {
    // Keep the acknowledged record on the current brief. Model a later capacity stop.
    const task = s.coding.jobs['synthetic-task'];
    task.result.result = 'merged_pr';
    task.followThrough.reason = 'Patch exceeds the review limit. Split the task or review this PR manually.';
  });
  const before = await fixture.store.read(); const calls = JSON.stringify(fixture.modelCalls());
  await login(page, fixture);
  const summary = () => page.locator('p.summary').innerText();
  if (!/^State: Completed\./.test(await summary()) || !/Progress: PR merged; deployment is separate\./.test(await summary())
    || /Eve stopped|deployment not verified|deployed/i.test(await summary())) kit.fail('completed-review-summary', await summary());
  if (await page.locator('section.ask textarea').isDisabled()) kit.fail('completed-review-input-disabled', 'input disabled');
  kit.pass('merged-closed-task-no-longer-blocked', { state: 'completed', requestInputAvailable: true });
  await screenshot(page);

  await fixture.store.change(s => { delete s.coding.jobs['synthetic-task'].releasedAt; });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('p.summary')?.textContent?.includes('run not closed'));
  if (/^State: Completed\./.test(await summary())) kit.fail('unreleased-writer-marked-completed', await summary());
  kit.pass('unreleased-writer-keeps-close-run-guidance', true);

  await fixture.store.change(s => {
    s.coding.jobs['synthetic-task'].releasedAt = before.coding.jobs['synthetic-task'].releasedAt;
    s.requests[reviewId].status = 'held';
  });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('p.summary')?.textContent?.includes('Blocker: provider refused'));
  if (!/^State: Blocked\./.test(await summary())) kit.fail('held-review-hidden-by-merge', await summary());
  kit.pass('held-prior-brief-review-remains-blocked', true);

  await fixture.store.change(s => { s.requests[reviewId].status = 'rejection_acknowledged'; });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('p.summary')?.textContent?.startsWith('State: Completed.'));
  await fixture.store.change(s => {
    s.requests['review-envelope-size'] = { id: 'review-envelope-size', purpose: 'coding_review', taskId: 'synthetic-task',
      contextRevision: s.project.revision, status: 'not_sent', createdAt: new Date().toISOString(),
      message: 'Synthetic automatic review refused before provider I/O',
      admissionFailure: { code: 'REVIEW_CONTEXT_TOO_LARGE', requestBytes: 48_001, at: new Date().toISOString() } };
  });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('p.summary')?.textContent?.startsWith('State: Completed.'));
  await page.getByText('Review not sent · size limit', { exact: true }).waitFor({ timeout: 20000 });
  await page.getByText('The review exceeded its request-size limit before any provider call. No model allowance was reserved for this review.', { exact: true }).waitFor({ timeout: 20000 });
  if (!/^State: Completed\./.test(await summary()) || /review envelope exceeds|split the coding task/.test(await summary())
    || await page.locator('section.ask textarea').isDisabled()) kit.fail('settled-refusal-still-blocks', await summary());
  kit.pass('settled-size-refusal-stays-in-history-without-blocking', true);
  await fixture.store.change(s => {
    s.requests['ordinary-not-sent'] = { id: 'ordinary-not-sent', contextRevision: s.project.revision, status: 'not_sent',
      createdAt: new Date().toISOString(), message: 'Synthetic ordinary request not admitted' };
  });
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await page.getByText('Not sent · check allowance or brief size', { exact: true }).waitFor({ timeout: 20000 });
  if (!/^State: Blocked\./.test(await summary()) || !/the last request was not sent/.test(await summary())) kit.fail('ordinary-refusal-hidden', await summary());
  await page.getByText('The model was not contacted and no allowance was reserved. Check your remaining allowance and brief size, then submit a new request.', { exact: true }).waitFor({ timeout: 20000 });
  kit.pass('ordinary-not-sent-history-keeps-generic-wording', true);
  const after = await fixture.store.read();
  if (JSON.stringify(fixture.modelCalls()) !== calls || before.reservedMicros !== after.reservedMicros
    || JSON.stringify(before.coding.jobs['synthetic-task'].followThrough) !== JSON.stringify(after.coding.jobs['synthetic-task'].followThrough)
    || JSON.stringify(before.requests[reviewId].provider) !== JSON.stringify(after.requests[reviewId].provider)) kit.fail('completed-history-mutated', 'model call or changed evidence/accounting');
  kit.pass('completion-survives-refresh-with-history-and-accounting', { noModelCalls: true, stoppedHistoryRetained: true });
  return kit.assertions;
}
