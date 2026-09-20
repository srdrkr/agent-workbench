import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeLedger, openLedger, beginCase, ledgerSummary, EVAL_MODEL, validateBudget, caseIdsForSet, validateCaseBudget } from '../eval-ledger.js';
import { evalTransport } from '../eval-transport.js';
import { inspectEvalResult, recordScopedResult, runGatewayEval } from '../eval-gateway.js';
import { proposalSchema } from '../schema.js';
import { z } from 'zod';

const repo = resolve(import.meta.dirname, '../../..');
const project = JSON.parse(readFileSync(join(repo, 'fixtures/steward-project.json'), 'utf8'));
const cases = JSON.parse(readFileSync(join(repo, 'fixtures/steward-evals.json'), 'utf8')).cases;
const endpoint = 'https://ai-gateway.vercel.sh/v4/ai/language-model';
const request = { method: 'POST', headers: { 'ai-language-model-id': EVAL_MODEL }, body: JSON.stringify({
  maxOutputTokens: 2048, prompt: [{ role: 'user', content: 'synthetic' }],
  tools: [{ type: 'function', name: 'final_output', inputSchema: z.toJSONSchema(proposalSchema) }],
  providerOptions: { gateway: { models: ['unapproved/model'], only: ['other'], byok: { secret: 'synthetic' } } },
}) };

test('strict wire schema retains required citations while local validation retains all bounds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-eval-strict-'));
  const path = join(dir, 'run.sqlite');
  initializeLedger(path, { project, cases, mode: 'live', fixtureHash: 'synthetic' });
  const db = openLedger(path);
  try {
    const record = beginCase(db, 'next-step');
    let wire;
    await evalTransport({ ledgerPath: path, caseId: record.id, sessionId: 'wrun_synthetic', messageHash: record.message_hash,
      send: async (_url, init) => { wire = JSON.parse(init.body); return new Response(); } })(endpoint, request);
    assert.equal(wire.tools.length, 1);
    assert.equal(wire.tools[0].strict, true);
    const schema = wire.tools[0].inputSchema;
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes('citations'));
    assert.equal(schema.properties.citations.type, 'array');
    assert.equal(schema.properties.citations.minItems, 1);
    assert.deepEqual(schema.properties.kind.enum, ['coding', 'commitment', 'clarify']);
    assert.deepEqual(schema.properties.candidateId.anyOf.map(item => item.type), ['string', 'null']);
    assert.ok(!/"(?:minLength|maxLength|maxItems)":/.test(JSON.stringify(schema)));
    assert.match(schema.properties.rationale.description, /Maximum string length: 2000/);
    const valid = { kind: 'coding', candidateId: 'normalize', title: 'Next step', rationale: 'Bounded fix.', citations: ['brief'], question: null };
    for (const invalid of [
      { ...valid, citations: undefined }, { ...valid, citations: [] },
      { ...valid, citations: Array(13).fill('brief') }, { ...valid, title: '' },
      { ...valid, rationale: 'x'.repeat(2001) }, { ...valid, candidateId: 'x'.repeat(121) },
      { ...valid, merge: true },
    ]) assert.equal(proposalSchema.safeParse(invalid).success, false);
    assert.equal(proposalSchema.safeParse(valid).success, true);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('follow-up budget can only decrease and blocks requests before I/O', async () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, 1_000_001]) assert.throws(() => validateBudget(value), /EVAL_BUDGET_INVALID/);
  const dir = await mkdtemp(join(tmpdir(), 'workbench-eval-budget-'));
  const path = join(dir, 'run.sqlite');
  initializeLedger(path, { project, cases, mode: 'live', fixtureHash: 'synthetic', budgetMicros: 1 });
  const db = openLedger(path);
  try {
    assert.equal(ledgerSummary(db).budgetMicros, 1);
    const record = beginCase(db, 'next-step');
    let calls = 0;
    await assert.rejects(evalTransport({ ledgerPath: path, caseId: record.id, sessionId: 'wrun_synthetic', messageHash: record.message_hash,
      send: async () => { calls++; return new Response(); } })(endpoint, request), /EVAL_PROVIDER_ADMISSION_DENIED/);
    assert.equal(calls, 0);
    assert.equal(ledgerSummary(db).cases[0].reservedMicros, 0);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('malformed live-output shape stays rejected and failure evidence excludes raw errors', () => {
  // Observed first-run failure: apparent citations were placed in rationale,
  // leaving the required citations property absent. Never repair from prose.
  const malformed = { kind: 'coding', candidateId: 'normalize', title: 'Propose the normalization fix',
    rationale: 'Owner approval is required.</parationale>\n<parameter name="citations">["brief", "acceptance"]', question: null };
  const events = [
    { type: 'step.completed', data: { usage: { costUsd: 0.018615, inputTokens: 1763, outputTokens: 392 },
      providerMetadata: { gateway: { generationId: 'gen_synthetic' } } } },
    { type: 'step.failed', data: { message: 'JUDGE_STEP_LIMIT', details: { raw: 'synthetic-private-error' } } },
    { type: 'turn.failed', data: { message: 'synthetic-private-error' } },
    { type: 'session.failed', data: { message: 'synthetic-private-error' } },
  ];
  const inspected = inspectEvalResult({ status: 'failed', data: malformed, events }, 115070);
  assert.equal(inspected.completed, false);
  assert.equal(inspected.proposal, null);
  assert.equal(inspected.evidence.completion.schemaValid, false);
  assert.equal(inspected.evidence.completion.stepLimitReached, true);
  assert.ok(inspected.evidence.heldReasons.includes('output_schema_invalid'));
  assert.ok(inspected.evidence.heldReasons.includes('runtime_failed'));
  assert.equal(inspected.evidence.steps[0].usage.costUsd, 0.018615);
  assert.ok(!JSON.stringify(inspected).includes('synthetic-private-error'));
  // Eve's actual failed turn returned no accepted data at all.
  assert.equal(inspectEvalResult({ status: 'failed', data: undefined, events }, 115070).completed, false);
  // Even a schema-valid result cannot override a failed step or exceed its reserve.
  const valid = { ...malformed, rationale: 'Synthetic valid proposal.', citations: ['brief', 'acceptance'] };
  const completedEvents = [{ type: 'turn.completed' }, { type: 'result.completed' }];
  assert.equal(inspectEvalResult({ status: 'waiting', data: valid, events: [...events, ...completedEvents] }, 115070).completed, false);
  const completedResult = { status: 'waiting', data: valid, events: [events[0], ...completedEvents] };
  assert.equal(inspectEvalResult(completedResult, 115070).completed, true);
  assert.ok(inspectEvalResult(completedResult, 1).evidence.heldReasons.includes('cost_reservation_exceeded'));
});

test('durable provider admission precedes I/O and survives errors and new model instances', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-eval-ledger-'));
  const path = join(dir, 'run.sqlite');
  initializeLedger(path, { project, cases, mode: 'live', fixtureHash: 'synthetic' });
  const db = openLedger(path);
  try {
    const record = beginCase(db, 'next-step');
    let calls = 0;
    const config = { ledgerPath: path, caseId: record.id, sessionId: 'wrun_synthetic', messageHash: record.message_hash,
      send: async (_url, init) => {
        calls++;
        assert.ok(db.prepare('SELECT reserved_micros FROM cases WHERE id=?').get(record.id).reserved_micros > 0);
        assert.deepEqual(JSON.parse(init.body).providerOptions, { gateway: { only: ['anthropic'], models: [], byok: {} } });
        assert.equal(init.redirect, 'error');
        throw new Error('synthetic credential and raw provider body');
      } };
    await assert.rejects(evalTransport(config)(endpoint, request), /^Error: EVAL_PROVIDER_OUTCOME_UNKNOWN$/);
    // A fresh closure represents a reloaded workflow/model. It still cannot call.
    await assert.rejects(evalTransport(config)(endpoint, request), /EVAL_PROVIDER_ADMISSION_DENIED/);
    assert.equal(calls, 1);
    assert.throws(() => beginCase(db, 'commitment'), /EVAL_CASE_HELD/);
    assert.equal(ledgerSummary(db).cases[0].status, 'create_intent');
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('schema-valid out-of-scope results hold the run before the next provider admission', async () => {
  const valid = { kind: 'coding', candidateId: 'normalize', title: 'Next step',
    rationale: 'Synthetic proposal.', citations: ['brief', 'acceptance'], question: null };
  for (const proposal of [
    { ...valid, citations: ['invented'] }, { ...valid, citations: ['brief'] },
    { ...valid, candidateId: 'unapproved' },
    { ...valid, kind: 'commitment' }, { ...valid, question: 'Unexpected question?' },
    { ...valid, kind: 'clarify', candidateId: null },
  ]) {
    const dir = await mkdtemp(join(tmpdir(), 'workbench-eval-scope-'));
    const path = join(dir, 'run.sqlite');
    initializeLedger(path, { project, cases, mode: 'live', fixtureHash: 'synthetic' });
    const db = openLedger(path);
    try {
      const record = beginCase(db, 'next-step');
      let calls = 0;
      await evalTransport({ ledgerPath: path, caseId: record.id, sessionId: 'wrun_synthetic', messageHash: record.message_hash,
        send: async () => { calls++; return new Response(); } })(endpoint, request);
      const reserved = ledgerSummary(db).cases[0].reservedMicros;
      const inspected = inspectEvalResult({ status: 'waiting', data: proposal,
        events: [{ type: 'turn.completed' }, { type: 'result.completed' }] }, reserved);
      assert.equal(inspected.completed, true); // Shape/terminal evidence cannot grant scope.
      assert.equal(recordScopedResult(db, cases[0], { sessionId: 'wrun_synthetic', ...inspected }, project), false);
      const held = ledgerSummary(db);
      assert.equal(held.status, 'held');
      assert.equal(held.cases[0].status, 'held');
      assert.equal(held.cases[0].reservedMicros, reserved);
      assert.deepEqual(held.cases[0].evidence.heldReasons, ['output_scope_invalid']);
      assert.equal(held.cases[0].evidence.scopeValid, false);
      assert.equal(held.cases[0].evidence.kindMatches, proposal.kind === cases[0].expectedKind);
      assert.throws(() => beginCase(db, 'commitment'), /EVAL_CASE_HELD/);
      assert.ok(held.cases.slice(1).every(item => item.status === 'prepared' && item.reservedMicros === 0));
      assert.equal(calls, 1);
    } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('request limits deny before transport and before consuming provider authority', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-eval-limit-'));
  const path = join(dir, 'run.sqlite');
  initializeLedger(path, { project, cases, mode: 'live', fixtureHash: 'synthetic' });
  const db = openLedger(path);
  try {
    const record = beginCase(db, 'next-step');
    let calls = 0;
    const send = evalTransport({ ledgerPath: path, caseId: record.id, sessionId: 'wrun_synthetic', messageHash: record.message_hash,
      send: async () => { calls++; return new Response(); } });
    await assert.rejects(send('https://example.com/steal', request), /EVAL_REQUEST_DENIED/);
    const oversized = { ...JSON.parse(request.body), prompt: [{ role: 'user', content: 'x'.repeat(12_001) }] };
    await assert.rejects(send(endpoint, { ...request, body: JSON.stringify(oversized) }), /EVAL_PROVIDER_ADMISSION_DENIED/);
    db.prepare('UPDATE run SET budget_micros=1').run();
    await assert.rejects(send(endpoint, request), /EVAL_PROVIDER_ADMISSION_DENIED/);
    assert.equal(calls, 0);
    assert.equal(ledgerSummary(db).cases[0].reservedMicros, 0);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('five-case isolated Eve/Gateway SDK mock eval completes and cannot restart', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-eval-full-'));
  const runDir = join(dir, 'run');
  try {
    const result = await runGatewayEval({ runDir, mock: true, budgetMicros: 884930 });
    assert.equal(result.status, 'completed');
    assert.equal(result.mode, 'mock');
    assert.equal(result.budgetMicros, 884930);
    assert.equal(result.cases.length, 5);
    assert.ok(result.cases.every(item => item.status === 'completed' && item.httpStatus === 200 && item.evidence.kindMatches));
    assert.ok(result.cases.reduce((sum, item) => sum + item.reservedMicros, 0) < 884930);
    assert.ok(result.cases.every(item => item.evidence.costObserved === false));
    await assert.rejects(runGatewayEval({ runDir, mock: true }), error => error.code === 'EEXIST');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('case selection is a fixed ordered scope and cannot expand a held or existing ledger', async () => {
  assert.deepEqual(caseIdsForSet('remaining'), ['commitment', 'conflict', 'injection', 'unsupported-progress']);
  for (const invalid of ['', 'next-step', 'commitment,conflict', 'toString']) assert.throws(() => caseIdsForSet(invalid), /EVAL_CASE_SET_INVALID/);
  assert.throws(() => validateCaseBudget('remaining', 532261), /EVAL_BUDGET_INVALID/);
  const dir = await mkdtemp(join(tmpdir(), 'workbench-eval-selection-'));
  const path = join(dir, 'run.sqlite');
  const options = { project, cases: cases.slice(1), mode: 'mock', fixtureHash: 'synthetic', caseSet: 'remaining', budgetMicros: 532260 };
  try {
    for (const invalid of [cases, cases.slice(2), [...cases.slice(1)].reverse(), [cases[1], cases[1], ...cases.slice(3)]]) {
      assert.throws(() => initializeLedger(path, { ...options, cases: invalid }), /EVAL_CASE_SET_INVALID/);
    }
    initializeLedger(path, options);
    assert.throws(() => initializeLedger(path, { ...options, cases, caseSet: 'all' }), error => error.code === 'EEXIST');
    const db = openLedger(path);
    try {
      assert.equal(ledgerSummary(db).caseSet, 'remaining');
      assert.throws(() => beginCase(db, 'next-step'), /EVAL_CASE_HELD/);
      assert.throws(() => beginCase(db, 'conflict'), /EVAL_CASE_HELD/);
    } finally { db.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('remaining-case Eve mock fits the unreserved allowance without repeating next-step', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-eval-remaining-'));
  const runDir = join(dir, 'run');
  try {
    const result = await runGatewayEval({ runDir, mock: true, caseSet: 'remaining', budgetMicros: 532260 });
    assert.equal(result.status, 'completed');
    assert.equal(result.caseSet, 'remaining');
    assert.deepEqual(result.cases.map(item => item.id), caseIdsForSet('remaining'));
    assert.ok(result.cases.every(item => item.status === 'completed' && item.httpStatus === 200 && item.evidence.kindMatches));
    assert.ok(result.cases.reduce((sum, item) => sum + item.reservedMicros, 467740) <= 1_000_000);
    await assert.rejects(runGatewayEval({ runDir, mock: true, caseSet: 'all' }), error => error.code === 'EEXIST');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
