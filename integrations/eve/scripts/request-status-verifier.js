#!/usr/bin/env node
/**
 * Credential-free browser verification for the hosted request/status UI.
 * Usage: node scripts/request-status-verifier.js --evidence <dir> [--netns]
 *
 * Setup (browsers, npm ci, build:hosted) is expected before verification when
 * running under a network namespace.
 */
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import {
  startRequestStatusFixture,
  PROPOSAL_OK,
  eveRoot,
  repoRoot,
  scrubArtifactText,
  resolveClientAssets,
} from './request-status-fixture.js';

const execFile = promisify(execFileCb);
const __dirname = dirname(fileURLToPath(import.meta.url));

function phxNow() {
  return new Date().toLocaleString('en-CA', { timeZone: 'America/Phoenix', hour12: false }).replace(', ', ' ') + ' MST';
}
function phxStamp() {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}${g('month')}${g('day')}-${g('hour')}${g('minute')}${g('second')}`;
}

function parseArgs(argv) {
  const out = { evidence: null, netns: false, skipBuild: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--evidence') out.evidence = argv[++i];
    else if (a === '--netns') out.netns = true;
    else if (a === '--skip-build') out.skipBuild = true;
    else if (a === '--help') out.help = true;
  }
  return out;
}

async function gitSha(cwd) {
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  } catch { return null; }
}

async function ensureSpaBuild() {
  try {
    await resolveClientAssets(eveRoot);
    return { built: false, reason: 'existing-generate-public' };
  } catch {
    // fall through
  }
  const node = process.execPath;
  const env = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    CI: 'true',
    EVE_TELEMETRY_DISABLED: '1',
    EVE_TRACES_CONTENT: 'off',
  };
  // Least-invasive SPA shell: official `nuxt generate` (no config edits). Emits
  // .output/public/index.html with window.__NUXT__.config for ssr:false clients.
  // Distinct from CI `build:hosted` (Vercel preset), which we still run separately.
  await new Promise((resolvePromise, reject) => {
    const child = spawn(node, [join(eveRoot, 'node_modules/nuxt/bin/nuxt.mjs'), 'generate'], {
      cwd: eveRoot, env, stdio: 'inherit',
    });
    child.on('exit', code => code === 0 ? resolvePromise() : reject(new Error(`nuxt generate exit ${code}`)));
  });
  await resolveClientAssets(eveRoot);
  return { built: true, reason: 'ran-nuxt-generate' };
}

async function withFixture(evidenceDir, fn) {
  const pgDir = await mkdtemp(join(tmpdir(), 'eve-rsv-pg-'));
  let fixture;
  const cleanup = { pgDirRemoved: false, browserClosed: false, serverClosed: false, leftoverProcesses: [], leftoverPorts: [], errors: [] };
  let browser;
  let result;
  try {
    fixture = await startRequestStatusFixture({ pgDir });
    browser = await chromium.launch({ headless: true });
    result = await fn({ fixture, browser, evidenceDir, pgDir });
  } finally {
    try { if (browser) { await browser.close(); cleanup.browserClosed = true; } } catch (e) { cleanup.errors.push(`browser:${e.message}`); }
    try { if (fixture) { await fixture.close(); cleanup.serverClosed = true; } } catch (e) { cleanup.errors.push(`server:${e.message}`); }
    try { await rm(pgDir, { recursive: true, force: true }); cleanup.pgDirRemoved = !existsSync(pgDir); } catch (e) { cleanup.errors.push(`pg:${e.message}`); }
    if (fixture?.port) {
      try {
        const { stdout } = await execFile('bash', ['-lc', `ss -ltnp 2>/dev/null | grep -E ':${fixture.port}\\b' || true`]);
        cleanup.leftoverPorts = stdout.trim() ? [stdout.trim()] : [];
        cleanup.psSnapshot = [];
      } catch { /* ss may be absent */ }
    }
  }
  return { result, cleanup };
}

async function installBrowserRoute(context, fixture, scenarioFailures) {
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') {
      await route.continue();
      return;
    }
    if (url.origin === fixture.origin) {
      await route.continue();
      return;
    }
    fixture.blockedBrowser.push({
      at: new Date().toISOString(),
      source: 'browser',
      url: url.href,
      method: req.method(),
    });
    scenarioFailures.push(`unexpected-browser-request:${url.href}`);
    await route.abort('blockedbyclient');
  });
}

async function login(page, fixture) {
  const { email, password } = fixture.getOwnerLogin();
  await page.goto(fixture.origin + '/', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').waitFor({ timeout: 20000 });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Open my workspace' }).click();
  await page.getByText('YOUR WORKSPACE').waitFor({ timeout: 20000 });
  await page.getByRole('heading', { name: 'Help centre links' }).waitFor({ timeout: 20000 });
}

async function scenarioStartFinish({ fixture, page, shots }) {
  const assertions = [];
  const fail = (name, observed) => { assertions.push({ name, ok: false, observed }); throw new Error(name + ': ' + observed); };
  const pass = (name, observed) => assertions.push({ name, ok: true, observed });

  fixture.judge.hold();
  const proposeWait = page.getByRole('button', { name: 'Ask Eve' });
  await page.getByLabel('Request to Eve').fill('What is the next useful step for link normalization?');
  // Click without waiting for network idle — propose stays open while judge held
  const called = fixture.judge.waitUntilCalled({ timeoutMs: 20000 });
  await proposeWait.click();
  await called;

  // In-progress indication from app.vue notice while busy
  const considering = page.getByText('Eve is considering your request. This can take about a minute.');
  try {
    await considering.waitFor({ timeout: 10000 });
  } catch (error) {
    fail('missing-in-progress-state', 'Expected visible in-progress notice "Eve is considering your request. This can take about a minute." while the synthetic judge is held');
  }
  pass('in-progress-notice-visible', await considering.textContent());
  await shots.inProgress();

  // Optional: Waiting for Eve tag via refresh interval / busy refresh
  // Release with valid commitment proposal
  fixture.judge.release(PROPOSAL_OK);

  await page.getByRole('heading', { name: 'Confirm the normalization priority' }).waitFor({ timeout: 20000 });
  pass('proposal-title-visible', 'Confirm the normalization priority');
  const approve = page.getByRole('button', { name: 'Approve commitment' });
  await approve.waitFor({ timeout: 10000 });
  pass('approve-commitment-visible', true);

  const committed = await page.getByText('Committed', { exact: true }).count();
  if (committed > 0) fail('must-not-show-approved-commitment', `found Committed tags=${committed}`);
  pass('no-approved-commitment-tag', 'Committed not shown');

  const codingHeading = await page.getByRole('heading', { name: 'Coding progress' }).count();
  if (codingHeading > 0) fail('must-not-show-coding-progress', 'Coding progress section present');
  pass('no-coding-progress-section', 'absent');

  await shots.final();
  return assertions;
}

async function scenarioBlocked({ fixture, page, shots }) {
  const assertions = [];
  const fail = (name, observed) => { assertions.push({ name, ok: false, observed }); throw new Error(name + ': ' + observed); };
  const pass = (name, observed) => assertions.push({ name, ok: true, observed });

  fixture.judge.hold();
  await page.getByLabel('Request to Eve').fill('Please advise on the next step.');
  const called = fixture.judge.waitUntilCalled({ timeoutMs: 20000 });
  await page.getByRole('button', { name: 'Ask Eve' }).click();
  await called;
  try {
    await page.getByText('Eve is considering your request. This can take about a minute.').waitFor({ timeout: 10000 });
  } catch {
    fail('missing-in-progress-state', 'Expected visible in-progress notice while the synthetic judge is held (blocked scenario)');
  }
  // Unsuccessful but admitted: provider intent recorded, proposal missing → held
  fixture.judge.releaseHeld();

  await page.getByText('Needs operator review').waitFor({ timeout: 20000 });
  pass('held-status-visible', 'Needs operator review');
  const heldCopy = page.getByText('Eve did not return a verified proposal. The attempt is held for operator review.');
  await heldCopy.waitFor({ timeout: 10000 });
  pass('held-explanation-visible', await heldCopy.textContent());

  // Next action: Refresh status (ask form is blocked while held)
  const refresh = page.getByRole('button', { name: 'Refresh status' });
  await refresh.waitFor({ timeout: 10000 });
  pass('refresh-status-available', true);
  const blockedNotice = page.getByText('A prior model attempt needs review');
  await blockedNotice.waitFor({ timeout: 10000 });
  pass('blocked-next-action-notice', await blockedNotice.textContent());

  await shots.blocked();
  // Ensure we did not falsely show awaiting approval approve button for this record
  const approve = await page.getByRole('button', { name: 'Approve commitment' }).count();
  if (approve > 0) fail('held-must-not-offer-approve', `approve buttons=${approve}`);
  pass('held-no-approve-commitment', 'absent');
  return assertions;
}

function assertionKit() {
  const assertions = [];
  const fail = (name, observed) => { assertions.push({ name, ok: false, observed }); throw new Error(name + ': ' + observed); };
  const pass = (name, observed) => assertions.push({ name, ok: true, observed });
  return { assertions, fail, pass };
}
const sameCalls = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function expectHandoff(page, kind, { fail, pass }) {
  const handoff = page.locator(`[data-recovery-case="${kind}"]`);
  try { await handoff.waitFor({ timeout: 20000 }); } catch { fail('missing-recovery-handoff', `Expected a handoff for case ${kind}`); }
  const text = await handoff.innerText();
  for (const label of ['What happened', 'Still unknown', 'Who needs to act', 'Next step']) {
    if (!text.includes(label)) fail('handoff-field-missing', label);
  }
  pass(`handoff-${kind}-visible`, text.replace(/\s+/g, ' ').slice(0, 600));
  return { handoff, text };
}

async function scenarioRejectedReviewRecovery({ fixture, page, shots }) {
  const kit = assertionKit(); const { fail, pass } = kit;
  const { reviewId } = await fixture.prepareHeldReview('refused');
  await login(page, fixture);
  await page.getByText('Needs operator review').first().waitFor({ timeout: 20000 });
  const { text } = await expectHandoff(page, 'confirmed_rejection', kit);
  if (!/refused/.test(text) || !/You \(the owner\)/.test(text)) fail('handoff-content', text.slice(0, 300));
  if (!(await page.getByLabel('Request to Eve').isDisabled())) fail('ask-must-be-blocked-while-held', 'enabled');
  pass('ask-blocked-while-held', true);
  if (await page.getByRole('button', { name: 'Retry this request once' }).count()) fail('coding-review-must-not-offer-retry', 'retry shown');
  pass('no-proposal-retry-for-coding-review', true);
  const heldSummary = await page.locator('p.summary[data-owner-state="blocked"]').innerText().catch(() => '');
  if (!/Next: acknowledge the failed review in the web app, then start a fresh request/.test(heldSummary)) fail('summary-disagrees-with-handoff', heldSummary);
  pass('summary-agrees-with-handoff', heldSummary);
  await shots.held();
  const ack = page.getByRole('button', { name: 'Acknowledge failed review' });
  try { await ack.waitFor({ timeout: 10000 }); } catch { fail('missing-acknowledge-control', 'Acknowledge failed review button absent'); }
  await shots.available(ack);
  pass('acknowledge-available', true);

  const stateBefore = await fixture.store.read(); const callsBefore = fixture.modelCalls();
  await ack.click();
  try { await page.getByText('Failed review acknowledged · history kept').waitFor({ timeout: 20000 }); }
  catch { fail('acknowledgement-not-shown', 'Expected label "Failed review acknowledged · history kept" after acknowledging'); }
  const callsAfter = fixture.modelCalls();
  if (!sameCalls(callsBefore, callsAfter)) fail('acknowledge-sent-model-request', JSON.stringify({ callsBefore, callsAfter }));
  pass('acknowledge-no-model-or-routine-request', callsAfter);
  const stateAfter = await fixture.store.read(); const record = stateAfter.requests[reviewId];
  if (record.status !== 'rejection_acknowledged') fail('acknowledgement-not-persisted', record.status);
  if (JSON.stringify(record.provider) !== JSON.stringify(stateBefore.requests[reviewId].provider) || stateAfter.reservedMicros !== stateBefore.reservedMicros
    || JSON.stringify(stateAfter.coding) !== JSON.stringify(stateBefore.coding)) fail('records-or-accounting-changed', 'provider/reservation/task changed');
  pass('records-and-accounting-retained', { reservedMicros: stateAfter.reservedMicros, retained: record.provider.reservedMicros });

  await page.reload({ waitUntil: 'domcontentloaded' });
  try { await page.getByText('Failed review acknowledged · history kept').waitFor({ timeout: 20000 }); }
  catch { fail('acknowledgement-not-persisted', 'label missing after reload'); }
  if (await page.getByRole('button', { name: 'Acknowledge failed review' }).count()) fail('acknowledge-still-offered', 'after reload');
  pass('acknowledgement-persisted-after-reload', true);
  const readySummary = await page.locator('p.summary[data-owner-state="awaiting_decision"]').innerText().catch(() => '');
  if (!/Next: review the PR yourself or start a fresh request; the failed review stays in history/.test(readySummary)) fail('summary-disagrees-after-acknowledge', readySummary);
  pass('summary-agrees-after-acknowledge', readySummary);
  const fresh = page.getByRole('button', { name: 'Start a fresh request' });
  try { await fresh.waitFor({ timeout: 10000 }); } catch { fail('missing-next-step', 'Start a fresh request button absent'); }
  await fresh.click();
  await page.waitForFunction(() => document.activeElement?.id === 'request', null, { timeout: 5000 }).catch(() => fail('next-step-not-reachable', 'request field not focused'));
  if (await page.getByLabel('Request to Eve').isDisabled()) fail('next-step-not-reachable', 'request field disabled');
  pass('next-step-fresh-request-reachable', true);
  await shots.after();

  fixture.judge.hold();
  await page.getByLabel('Request to Eve').fill('After the failed review, what is the next useful step?');
  const called = fixture.judge.waitUntilCalled({ timeoutMs: 20000 });
  await page.getByRole('button', { name: 'Ask Eve' }).click();
  await called;
  fixture.judge.release(PROPOSAL_OK);
  await page.getByRole('heading', { name: 'Confirm the normalization priority' }).waitFor({ timeout: 20000 });
  await page.getByRole('button', { name: 'Approve commitment' }).waitFor({ timeout: 10000 });
  const finalState = await fixture.store.read();
  const freshIds = Object.keys(finalState.requests).filter(id => id !== reviewId);
  if (freshIds.length !== 1 || finalState.requests[freshIds[0]].status !== 'awaiting_approval') fail('fresh-request-not-created', JSON.stringify(freshIds));
  const finalCalls = fixture.modelCalls();
  if (finalCalls.reviewJudge !== callsBefore.reviewJudge || finalCalls.reviewProviderSend !== callsBefore.reviewProviderSend) fail('review-was-retried', JSON.stringify(finalCalls));
  pass('fresh-request-awaits-fresh-approval', { newRequestId: freshIds[0] !== reviewId, calls: finalCalls });
  return kit.assertions;
}

async function scenarioUncertainReviewBlocked({ fixture, page, shots }) {
  const kit = assertionKit(); const { fail, pass } = kit;
  const { reviewId } = await fixture.prepareHeldReview('lost');
  await login(page, fixture);
  await page.getByText('Needs operator review').first().waitFor({ timeout: 20000 });
  const { text } = await expectHandoff(page, 'uncertain_delivery', kit);
  if (!text.includes('Missing evidence or capability') || !/session reconciliation/.test(text) || !/Keep this held/.test(text)) fail('uncertain-handoff-content', text.slice(0, 400));
  pass('uncertain-handoff-names-missing-capability', true);
  if (await page.getByRole('button', { name: 'Acknowledge failed review' }).count()) fail('uncertain-must-not-offer-acknowledge', 'shown');
  if (await page.getByRole('button', { name: 'Retry this request once' }).count()) fail('uncertain-must-not-offer-retry', 'shown');
  if (!(await page.getByLabel('Request to Eve').isDisabled())) fail('uncertain-must-block-new-requests', 'ask enabled');
  pass('uncertain-offers-no-recovery-and-blocks-requests', true);
  const uncertainSummary = await page.locator('p.summary[data-owner-state="blocked"]').innerText().catch(() => '');
  if (!/Next: operator: check provider usage for the held attempt; do not resend/.test(uncertainSummary)) fail('summary-disagrees-with-uncertain-handoff', uncertainSummary);
  pass('summary-agrees-with-uncertain-handoff', uncertainSummary);
  await shots.uncertain();
  const callsBefore = fixture.modelCalls();
  const direct = await page.evaluate(async id => {
    const r = await fetch('/api/steward/recovery/acknowledge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: id, acknowledgeHash: 'a'.repeat(64) }) });
    return { status: r.status, body: await r.json() };
  }, reviewId);
  if (direct.status !== 409 || direct.body.error !== 'RECOVERY_NOT_SUPPORTED') fail('uncertain-direct-acknowledge-not-rejected', JSON.stringify(direct));
  const record = (await fixture.store.read()).requests[reviewId];
  if (record.status !== 'held') fail('uncertain-record-changed', record.status);
  if (!sameCalls(callsBefore, fixture.modelCalls())) fail('uncertain-sent-model-request', JSON.stringify(fixture.modelCalls()));
  pass('uncertain-direct-acknowledge-rejected', direct);
  return kit.assertions;
}

// Reads every status surface at once, so each checkpoint is one consistent observation.
async function surfaces(page) {
  return page.evaluate(() => {
    const text = el => (el ? el.innerText.replace(/\s+/g, ' ').trim() : null);
    const summary = document.querySelector('p.summary');
    const ask = document.querySelector('section.ask');
    return {
      ownerState: summary?.dataset.ownerState ?? null, summary: text(summary),
      button: text(ask?.querySelector('button')), buttonDisabled: Boolean(ask?.querySelector('button')?.disabled),
      requestDisabled: Boolean(document.getElementById('request')?.disabled),
      askNotice: text(ask?.querySelector('p.notice')),
      cards: [...document.querySelectorAll('article.decision')].map(a => ({ tag: text(a.querySelector('.tag')), body: text(a) })),
    };
  });
}

// Invariants per owner state: every surface must tell the same story.
function agreement(s, key) {
  const problems = [];
  if (s.ownerState !== key) problems.push(`summary state ${s.ownerState} != ${key}`);
  const all = [s.summary, s.button, s.askNotice, ...s.cards.map(c => c.body)].filter(Boolean).join(' | ');
  if (key === 'working') {
    if (!/^State: In progress\./.test(s.summary)) problems.push('summary does not say In progress');
    if (/ask Eve for the next useful step|ask again|send it again\b(?! is)|submit a new request/i.test(all.replace(/you do not need to send it again|no need to send the request again/gi, ''))) problems.push('a surface invites resending');
    if (!['Working…', 'Eve is working…'].includes(s.button) || !s.buttonDisabled || !s.requestDisabled) problems.push(`ask panel not working: ${s.button}`);
    if (!/you do not need to send it again/.test(s.askNotice ?? '')) problems.push('ask notice does not say the request is in progress');
    if (s.cards[0]?.tag !== 'WAITING FOR EVE' && s.cards[0]?.tag !== 'Waiting for Eve') problems.push(`newest card is ${s.cards[0]?.tag}`);
  }
  if (key === 'awaiting_decision') {
    if (!/^State: Your decision needed\./.test(s.summary) || !/Next: decide on the proposal/.test(s.summary)) problems.push('summary does not ask for a decision');
    if (/\b(done|executed|completed)\b/i.test(s.summary)) problems.push('proposal described as executed');
    if (s.button !== 'Ask Eve') problems.push(`button ${s.button}`);
    if (!/your decision/i.test(s.cards[0]?.tag ?? '')) problems.push(`newest card is ${s.cards[0]?.tag}`);
  }
  if (key === 'completed') {
    if (!/^State: (Completed|Decision recorded)\./.test(s.summary) || !/Next: /.test(s.summary)) problems.push('summary not completed with a next step');
    if (!/committed/i.test(s.cards[0]?.tag ?? '')) problems.push(`newest card is ${s.cards[0]?.tag}`);
  }
  if (key === 'blocked') {
    if (!/^State: Blocked\./.test(s.summary) || !/Next: (review the held attempt|operator: |acknowledge the failed review)/.test(s.summary)) problems.push('summary not blocked with next step');
    if (!/needs review/.test(s.askNotice ?? '')) problems.push('ask notice does not name the held attempt');
    if (!/needs operator review/i.test(s.cards[0]?.tag ?? '')) problems.push(`newest card is ${s.cards[0]?.tag}`);
  }
  return problems;
}

async function expectAgreement(page, key, name, kit, timeline) {
  // Wait on the DOM (no sleeps) until the summary reports the state, then check every surface.
  await page.locator(`p.summary[data-owner-state="${key}"]`).waitFor({ timeout: 20000 }).catch(() => {});
  const s = await surfaces(page);
  timeline.push({ checkpoint: name, at: new Date().toISOString(), ...s });
  const problems = agreement(s, key);
  if (problems.length) kit.fail(`surfaces-disagree:${name}`, `${problems.join('; ')} :: summary="${s.summary}" button="${s.button}"`);
  kit.pass(`surfaces-agree:${name}`, { summary: s.summary, button: s.button, askNotice: s.askNotice, newestCard: s.cards[0]?.tag });
}

async function scenarioProgressWorking({ fixture, page, shots, timeline }) {
  const kit = assertionKit();
  await login(page, fixture);
  await page.locator('p.summary[data-owner-state="ready"]').waitFor({ timeout: 20000 });
  kit.pass('initial-ready', await page.locator('p.summary').innerText());
  fixture.judge.hold();
  await page.getByLabel('Request to Eve').fill('What is the next useful step for link normalization?');
  const called = fixture.judge.waitUntilCalled({ timeoutMs: 20000 });
  await page.getByRole('button', { name: 'Ask Eve' }).click();
  await called;
  // No poll has run yet: the first observation must already agree.
  const immediate = await surfaces(page);
  timeline.push({ checkpoint: 'immediately-after-submit', at: new Date().toISOString(), ...immediate });
  const early = agreement(immediate, 'working');
  if (early.length) kit.fail('surfaces-disagree:immediately-after-submit', `${early.join('; ')} :: summary="${immediate.summary}" button="${immediate.button}"`);
  kit.pass('surfaces-agree:immediately-after-submit', { summary: immediate.summary, button: immediate.button });
  await shots.working();
  // Manual refresh is available while the request runs and returns the durable record.
  const refresh = page.getByRole('button', { name: 'Refresh status' });
  if (await refresh.isDisabled()) kit.fail('refresh-disabled-while-working', 'Refresh status disabled');
  await refresh.click();
  await page.getByText('Eve is working on this request.').first().waitFor({ timeout: 20000 });
  await expectAgreement(page, 'working', 'after-manual-refresh', kit, timeline);
  // Reload mid-judge restores the durable working state.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('YOUR WORKSPACE').waitFor({ timeout: 20000 });
  await expectAgreement(page, 'working', 'after-reload-mid-judge', kit, timeline);
  if ((await page.getByRole('button', { name: 'Eve is working…' }).count()) !== 1) kit.fail('reload-button-not-working', 'no Eve is working… button');
  await shots.reload();
  if (fixture.judge.calls !== 1) kit.fail('duplicate-admission', `judge calls ${fixture.judge.calls}`);
  kit.pass('single-admission-after-reload', fixture.judge.calls);
  fixture.judge.release(PROPOSAL_OK);
  await page.getByRole('heading', { name: 'Confirm the normalization priority' }).waitFor({ timeout: 20000 });
  await expectAgreement(page, 'awaiting_decision', 'after-release', kit, timeline);
  await shots.awaiting();
  await page.getByRole('button', { name: 'Approve commitment' }).click();
  await page.getByText('Committed', { exact: true }).first().waitFor({ timeout: 20000 });
  await expectAgreement(page, 'completed', 'after-approval', kit, timeline);
  if (!/Next: work on: Confirm the normalization priority/.test(await page.locator('p.summary').innerText())) kit.fail('completed-next-step', 'missing work on');
  await shots.completed();
  if (fixture.judge.calls !== 1) kit.fail('duplicate-admission', `judge calls ${fixture.judge.calls}`);
  return kit.assertions;
}

async function scenarioProgressBlocked({ fixture, page, shots, timeline }) {
  const kit = assertionKit();
  await login(page, fixture);
  fixture.judge.hold();
  await page.getByLabel('Request to Eve').fill('Please advise on the next step.');
  const called = fixture.judge.waitUntilCalled({ timeoutMs: 20000 });
  await page.getByRole('button', { name: 'Ask Eve' }).click();
  await called;
  await expectAgreement(page, 'working', 'blocked-scenario-working', kit, timeline);
  fixture.judge.releaseHeld();
  await page.getByText('Needs operator review').first().waitFor({ timeout: 20000 });
  await expectAgreement(page, 'blocked', 'after-held', kit, timeline);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('YOUR WORKSPACE').waitFor({ timeout: 20000 });
  await expectAgreement(page, 'blocked', 'held-after-reload', kit, timeline);
  await shots.blocked();
  return kit.assertions;
}

async function runScenario({ name, evidenceDir, netnsReported, secrets, scenarios, scenarioFailures, cleanupResults, failureShot, body }) {
  const { cleanup } = await withFixture(evidenceDir, async ({ fixture, browser }) => {
    secrets.push(fixture.getOwnerLogin().email, fixture.getOwnerLogin().password, fixture._credentials.secret);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const routeFailures = [];
    await installBrowserRoute(context, fixture, routeFailures);
    const page = await context.newPage();
    const sc = { name, startedAt: phxNow(), ok: false, assertions: [], timeline: [], error: null, durationMs: 0 };
    const t0 = Date.now();
    try {
      sc.assertions = await body({ fixture, page, timeline: sc.timeline });
      if (routeFailures.length) throw new Error(`network-boundary:${routeFailures.join(';')}`);
      if (fixture.blockedBrowser.length || fixture.blockedNode.length) throw new Error(`blocked-network:${JSON.stringify([...fixture.blockedBrowser, ...fixture.blockedNode])}`);
      sc.ok = sc.assertions.every(a => a.ok);
    } catch (e) {
      sc.error = String(e.message || e); sc.ok = false;
      try { await page.screenshot({ path: join(evidenceDir, failureShot), fullPage: true }); } catch { /* ignore */ }
    } finally {
      sc.durationMs = Date.now() - t0; sc.finishedAt = phxNow();
      sc.modelCalls = fixture.modelCalls(); sc.judgeCalls = fixture.judge.calls;
      scenarios.push(sc);
      await context.close();
    }
    if (!sc.ok) scenarioFailures.push(sc.error || sc.name);
  });
  cleanupResults.push({ scenario: name, ...cleanup });
}

async function runOnce({ evidenceDir, netnsReported }) {
  const started = Date.now();
  const headSha = await gitSha(repoRoot);
  const baseSha = '342070c0e3c2e09205f4c8df38b3eb7f63644772';
  const scenarios = [];
  const scenarioFailures = [];
  let browserVersion = null;
  let networkCoverage = null;
  let cleanupResults = [];
  let secrets = [];

  // Scenario 1 — fresh fixture
  {
    const { cleanup } = await withFixture(evidenceDir, async ({ fixture, browser }) => {
      secrets = [fixture.getOwnerLogin().email, fixture.getOwnerLogin().password, fixture._credentials.secret];
      browserVersion = browser.version();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const routeFailures = [];
      await installBrowserRoute(context, fixture, routeFailures);
      const page = await context.newPage();
      const shots = {
        async loggedIn() { await page.screenshot({ path: join(evidenceDir, '01-logged-in.png'), fullPage: true }); },
        async inProgress() { await page.screenshot({ path: join(evidenceDir, '02-in-progress.png'), fullPage: true }); },
        async final() { await page.screenshot({ path: join(evidenceDir, '03-final-proposal.png'), fullPage: true }); },
        async blocked() {},
      };
      const sc = { name: 'start-finish-request', startedAt: phxNow(), ok: false, assertions: [], error: null, durationMs: 0 };
      const t0 = Date.now();
      try {
        await login(page, fixture);
        await shots.loggedIn();
        sc.assertions = await scenarioStartFinish({ fixture, page, shots });
        if (routeFailures.length) throw new Error(`network-boundary:${routeFailures.join(';')}`);
        if (fixture.blockedBrowser.length) throw new Error(`browser-blocked:${JSON.stringify(fixture.blockedBrowser)}`);
        sc.ok = sc.assertions.every(a => a.ok);
      } catch (e) {
        sc.error = String(e.message || e);
        sc.ok = false;
        try { await page.screenshot({ path: join(evidenceDir, '01-failure.png'), fullPage: true }); } catch { /* ignore */ }
      } finally {
        sc.durationMs = Date.now() - t0;
        sc.finishedAt = phxNow();
        networkCoverage = fixture.networkCoverage();
        networkCoverage.netns = Boolean(netnsReported);
        scenarios.push(sc);
        await context.close();
      }
      if (!sc.ok) scenarioFailures.push(sc.error || sc.name);
      return sc.name;
    });
    cleanupResults.push({ scenario: 'start-finish-request', ...cleanup });
  }

  // Scenario 2 — fresh fixture
  {
    const { cleanup } = await withFixture(evidenceDir, async ({ fixture, browser }) => {
      secrets.push(fixture.getOwnerLogin().email, fixture.getOwnerLogin().password, fixture._credentials.secret);
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const routeFailures = [];
      await installBrowserRoute(context, fixture, routeFailures);
      const page = await context.newPage();
      const shots = {
        async loggedIn() {},
        async inProgress() {},
        async final() {},
        async blocked() { await page.screenshot({ path: join(evidenceDir, '04-blocked.png'), fullPage: true }); },
      };
      const sc = { name: 'blocked-request', startedAt: phxNow(), ok: false, assertions: [], error: null, durationMs: 0 };
      const t0 = Date.now();
      try {
        await login(page, fixture);
        sc.assertions = await scenarioBlocked({ fixture, page, shots });
        if (routeFailures.length) throw new Error(`network-boundary:${routeFailures.join(';')}`);
        if (fixture.blockedBrowser.length) throw new Error(`browser-blocked:${JSON.stringify(fixture.blockedBrowser)}`);
        sc.ok = sc.assertions.every(a => a.ok);
      } catch (e) {
        sc.error = String(e.message || e);
        sc.ok = false;
        try { await page.screenshot({ path: join(evidenceDir, '04-failure.png'), fullPage: true }); } catch { /* ignore */ }
      } finally {
        sc.durationMs = Date.now() - t0;
        sc.finishedAt = phxNow();
        const cov = fixture.networkCoverage();
        cov.netns = Boolean(netnsReported);
        networkCoverage = {
          ...cov,
          blockedRequests: [...(networkCoverage?.blockedRequests || []), ...cov.blockedRequests],
        };
        scenarios.push(sc);
        await context.close();
      }
      if (!sc.ok) scenarioFailures.push(sc.error || sc.name);
      return sc.name;
    });
    cleanupResults.push({ scenario: 'blocked-request', ...cleanup });
  }

  // Scenarios 3 and 4 — held coding reviews, each on a fresh fixture
  const shared = { evidenceDir, netnsReported, secrets, scenarios, scenarioFailures, cleanupResults };
  await runScenario({ ...shared, name: 'held-rejected-review-recovery', failureShot: '05-failure.png', body: ({ fixture, page }) => scenarioRejectedReviewRecovery({ fixture, page, shots: {
    held: () => page.screenshot({ path: join(evidenceDir, '05-held-with-handoff.png'), fullPage: true }),
    available: ack => page.locator('article', { has: ack }).screenshot({ path: join(evidenceDir, '06-recovery-available.png') }),
    after: () => page.screenshot({ path: join(evidenceDir, '07-after-recovery-next-step.png'), fullPage: true }),
  } }) });
  await runScenario({ ...shared, name: 'held-uncertain-review-blocked', failureShot: '08-failure.png', body: ({ fixture, page }) => scenarioUncertainReviewBlocked({ fixture, page, shots: {
    uncertain: () => page.screenshot({ path: join(evidenceDir, '08-uncertain-still-blocked.png'), fullPage: true }),
  } }) });

  const shot = (page, file) => () => page.screenshot({ path: join(evidenceDir, file), fullPage: true });
  await runScenario({ ...shared, name: 'progress-consistency-working', failureShot: '09-failure.png', body: ({ fixture, page, timeline }) => scenarioProgressWorking({ fixture, page, timeline, shots: {
    working: shot(page, '09-working-immediately.png'), reload: shot(page, '10-working-after-reload.png'),
    awaiting: shot(page, '11-awaiting-decision.png'), completed: shot(page, '12-completed-next-step.png') } }) });
  await runScenario({ ...shared, name: 'progress-consistency-blocked', failureShot: '13-failure.png', body: ({ fixture, page, timeline }) => scenarioProgressBlocked({ fixture, page, timeline, shots: {
    blocked: shot(page, '13-blocked-next-step.png') } }) });

  const report = {
    generatedAt: phxNow(),
    baseSha,
    headSha,
    playwright: '1.63.0',
    browser: { product: 'Chromium', version: browserVersion, channel: 'playwright-chromium' },
    durationMs: Date.now() - started,
    scenarios,
    networkCoverage,
    cleanup: cleanupResults,
    ok: scenarios.every(s => s.ok) && scenarioFailures.length === 0,
    secretsScrubNote: 'Owner email/password/auth secret generated per fixture and never written into this report.',
  };

  const raw = JSON.stringify(report, null, 2);
  const scrubbed = scrubArtifactText(raw, secrets);
  await writeFile(join(evidenceDir, 'report.json'), scrubbed);
  // Grep evidence dir for secrets
  const leakCheck = { checkedAt: phxNow(), leaks: [] };
  for (const secret of secrets) {
    if (!secret) continue;
    const { stdout } = await execFile('bash', ['-lc', `grep -R --fixed-strings -l -- ${JSON.stringify(secret)} ${JSON.stringify(evidenceDir)} 2>/dev/null || true`]);
    if (stdout.trim()) leakCheck.leaks.push({ hint: secret.slice(0, 4) + '…', files: stdout.trim().split('\n') });
  }
  await writeFile(join(evidenceDir, 'scrub-check.json'), JSON.stringify(leakCheck, null, 2));
  if (leakCheck.leaks.length) {
    report.ok = false;
    report.scrubFailure = leakCheck;
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/request-status-verifier.js --evidence <dir> [--netns]');
    process.exit(0);
  }
  const evidenceDir = resolve(args.evidence || join(tmpdir(), `eve-rsv-${phxStamp()}`));
  await mkdir(evidenceDir, { recursive: true });

  if (!args.skipBuild) {
    const build = await ensureSpaBuild();
    await writeFile(join(evidenceDir, 'build.json'), JSON.stringify(build, null, 2));
  }

  // Optionally re-exec inside netns
  if (args.netns && process.env.EVE_RSV_IN_NETNS !== '1') {
    // Bring up loopback inside new netns and re-exec
    const self = fileURLToPath(import.meta.url);
    const childArgs = [self, '--evidence', evidenceDir, '--skip-build'];
    const result = await new Promise((resolvePromise) => {
      const child = spawn('unshare', ['-rn', 'bash', '-lc', `ip link set lo up 2>/dev/null || true; EVE_RSV_IN_NETNS=1 HOME=${JSON.stringify(process.env.HOME)} PATH=${JSON.stringify(process.env.PATH)} CI=true ${JSON.stringify(process.execPath)} ${childArgs.map(a => JSON.stringify(a)).join(' ')}; echo EXIT:$?`], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, EVE_RSV_IN_NETNS: '1' },
      });
      let out = ''; let err = '';
      child.stdout.on('data', d => { out += d; process.stdout.write(d); });
      child.stderr.on('data', d => { err += d; process.stderr.write(d); });
      child.on('exit', code => resolvePromise({ code, out, err }));
    });
    // Prefer report written by child
    try {
      const report = JSON.parse(await readFile(join(evidenceDir, 'report.json'), 'utf8'));
      report.networkCoverage = report.networkCoverage || {};
      report.networkCoverage.netns = true;
      report.networkCoverage.netnsNote = 'verification re-exec under unshare -rn with lo up';
      await writeFile(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2));
      process.exit(report.ok ? 0 : 1);
    } catch {
      console.error('netns child failed', result.code, result.err.slice(0, 500));
      process.exit(result.code || 1);
    }
  }

  // Probe whether netns works on this host (informational when not using --netns)
  let netnsAvailable = false;
  try {
    await execFile('unshare', ['-rn', 'true']);
    netnsAvailable = true;
  } catch { netnsAvailable = false; }

  const report = await runOnce({ evidenceDir, netnsReported: process.env.EVE_RSV_IN_NETNS === '1' });
  report.networkCoverage = report.networkCoverage || {};
  report.networkCoverage.netnsAvailable = netnsAvailable;
  report.networkCoverage.netns = process.env.EVE_RSV_IN_NETNS === '1';
  await writeFile(join(evidenceDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, evidenceDir, scenarios: report.scenarios.map(s => ({ name: s.name, ok: s.ok, error: s.error })) }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
