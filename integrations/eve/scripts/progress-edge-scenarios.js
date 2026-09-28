import { PENDING_REQUEST_KEY } from '../app/utils/pending-request.js';

export async function scenarioLostSubmission({ fixture, page, kit, login }) {
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
  await page.getByRole('button', { name: 'Retry saved request', exact: true }).click();
  await page.getByText('Submission outcome unknown', { exact: true }).waitFor({ state: 'detached', timeout: 20000 });
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
