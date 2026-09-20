import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createGateway } from 'ai';
import { z } from 'zod';
import { rejectionDiagnostics, parseRetryAfter } from '../rejection-diagnostics.js';
import { beginCase, caseReceipt, initializeLedger, ledgerSummary, openLedger, EVAL_MODEL } from '../eval-ledger.js';
import { evalTransport } from '../eval-transport.js';
import { boundedModel } from '../bounded-model.js';
import { proposalSchema } from '../schema.js';

test('rejection parser keeps only recognized categories, typed identifiers, and Retry-After', async () => {
  const response = new Response(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'PRIVATE_BODY',
    nested: { error: 'PRIVATE_NESTED' } }, request_id: 'req_12345678Abcd', prompt: 'PRIVATE_PROMPT' }),
  { status: 429, headers: { 'retry-after': '12', authorization: 'PRIVATE_CREDENTIAL', 'x-extra': 'PRIVATE_HEADER' } });
  assert.deepEqual(await rejectionDiagnostics(response), { httpStatus: 429, errorCategory: 'rate_limit_exceeded',
    requestIdentifier: { source: 'request_id', value: 'req_12345678Abcd' }, retryAfter: { kind: 'seconds', seconds: 12 } });
  assert.equal(response.bodyUsed, true);
  for (const category of ['quota_for_entity_exceeded', 'rate_limit_error', 'overloaded_error']) {
    const result = await rejectionDiagnostics(new Response(JSON.stringify({ error: { code: category }, generationId: 'gen_12345678Abcd' }), { status: 402 }));
    assert.equal(result.errorCategory, category);
    assert.deepEqual(result.requestIdentifier, { source: 'generationId', value: 'gen_12345678Abcd' });
  }
});

test('unknown, malformed, oversized, and hostile rejection values are omitted without inferring a cause', async () => {
  for (const body of ['PRIVATE_NOT_JSON', JSON.stringify({ error: { type: 'PRIVATE_CATEGORY', message: 'rate_limit_error',
    details: { type: 'overloaded_error' } }, request_id: 'req_PRIVATE_SECRET_WITH_UNDERSCORES', generationId: 'PRIVATE_ID' }),
  JSON.stringify({ error: { type: 'rate_limit_error' }, padding: 'x'.repeat(16384) }),
  new Uint8Array([255])]) {
    assert.deepEqual(await rejectionDiagnostics(new Response(body, { status: 429, headers: {
      'x-request-id': 'Bearer PRIVATE_KEY', 'request-id': 'req_' + 'a'.repeat(81), 'retry-after': 'PRIVATE_DELAY',
    } })), { httpStatus: 429, errorCategory: null, requestIdentifier: null, retryAfter: null });
  }
  const uuid = '12345678-abcd-abcd-abcd-123456789abc';
  const parsed = await rejectionDiagnostics(new Response(null, { status: 503, headers: { 'x-request-id': uuid } }));
  assert.deepEqual(parsed.requestIdentifier, { source: 'x-request-id', value: uuid });
});

test('Retry-After accepts bounded seconds or canonical HTTP dates, never arbitrary date-like text', () => {
  assert.deepEqual(parseRetryAfter('0'), { kind: 'seconds', seconds: 0 });
  assert.deepEqual(parseRetryAfter('604800'), { kind: 'seconds', seconds: 604800 });
  assert.deepEqual(parseRetryAfter('Fri, 18 Sep 2026 08:00:00 GMT'), { kind: 'date', at: '2026-09-18T08:00:00.000Z' });
  for (const value of [null, '', '-1', '1.5', '1e2', '604801', '9999999999999999999', ' 12 ',
    '2026-09-18', 'Thu, 18 Sep 2026 08:00:00 GMT', 'Fri, 32 Sep 2026 08:00:00 GMT', '12, 13']) {
    assert.equal(parseRetryAfter(value), null);
  }
});

test('a stalled or broken error body preserves header evidence within a fixed read deadline', { timeout: 3000 }, async () => {
  let cancelled = false;
  const stalled = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const parsed = await rejectionDiagnostics(new Response(stalled, { status: 429, headers: { 'retry-after': '7' } }));
  assert.deepEqual(parsed, { httpStatus: 429, errorCategory: null, requestIdentifier: null, retryAfter: { kind: 'seconds', seconds: 7 } });
  assert.equal(cancelled, true);
  const broken = new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE_STREAM_ERROR')); } });
  assert.equal((await rejectionDiagnostics(new Response(broken, { status: 503 }))).errorCategory, null);
});

test('SDK rejection diagnostics survive sanitization and restart; one admission and held accounting remain enforced', async () => {
  const repo = resolve(import.meta.dirname, '../../..');
  const project = JSON.parse(readFileSync(join(repo, 'fixtures/steward-project.json'), 'utf8'));
  const cases = JSON.parse(readFileSync(join(repo, 'fixtures/steward-evals.json'), 'utf8')).cases.slice(1);
  const dir = await mkdtemp(join(tmpdir(), 'workbench-rejection-'));
  const path = join(dir, 'run.sqlite');
  initializeLedger(path, { project, cases, mode: 'live', fixtureHash: 'synthetic', caseSet: 'remaining', budgetMicros: 532260 });
  let db = openLedger(path);
  try {
    const record = beginCase(db, 'commitment');
    let calls = 0;
    const config = { ledgerPath: path, caseId: record.id, sessionId: 'wrun_synthetic', messageHash: record.message_hash,
      send: async () => { calls++; return new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'PRIVATE_PROVIDER_BODY' } }),
        { status: 429, headers: { 'request-id': 'req_12345678Abcd', 'retry-after': '30', 'x-secret': 'PRIVATE_HEADER' } }); } };
    const model = () => boundedModel(createGateway({ apiKey: 'synthetic-only', fetch: evalTransport(config) })(EVAL_MODEL));
    const params = { prompt: [{ role: 'user', content: [{ type: 'text', text: record.message }] }],
      tools: [{ type: 'function', name: 'final_output', inputSchema: z.toJSONSchema(proposalSchema) }] };
    await assert.rejects(model().doStream(params), /^Error: JUDGE_MODEL_FAILED$/);
    const reserved = ledgerSummary(db).cases[0].reservedMicros;
    assert.ok(reserved > 0);
    caseReceipt(db, record.id, { status: 'held', evidence: { failure: 'EVAL_CASE_OUTCOME_UNKNOWN' } });
    db.close(); db = openLedger(path);
    await assert.rejects(model().doStream(params), /^Error: JUDGE_MODEL_FAILED$/);
    assert.equal(calls, 1);
    assert.throws(() => beginCase(db, 'conflict'), /EVAL_CASE_HELD/);
    assert.throws(() => beginCase(db, 'next-step'), /EVAL_CASE_HELD/);
    const summary = ledgerSummary(db);
    assert.equal(summary.status, 'held');
    assert.equal(summary.cases[0].reservedMicros, reserved);
    assert.deepEqual(summary.cases[0].rejection, { httpStatus: 429, errorCategory: 'rate_limit_error',
      requestIdentifier: { source: 'request-id', value: 'req_12345678Abcd' }, retryAfter: { kind: 'seconds', seconds: 30 } });
    assert.ok(summary.cases.slice(1).every(item => item.status === 'prepared' && item.reservedMicros === 0));
    assert.ok(!readFileSync(path).includes(Buffer.from('PRIVATE_')));
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('nested Gateway correlation and upstream status survive without provider prose or credentials', async () => {
  const gateway = { generationId: 'gen_SyntheticRouting12345678', routing: { modelAttempts: [{
    canonicalSlug: 'PRIVATE_MODEL', providerAttempts: [
      { provider: 'anthropic', success: false, statusCode: 503, error: 'Service temporarily unavailable', credential: 'PRIVATE_KEY' },
      { provider: 'anthropic', success: false, statusCode: 429, error: 'PRIVATE_PROVIDER_MESSAGE' },
      { provider: 'PRIVATE_PROVIDER', success: false, statusCode: 503, error: 'PRIVATE_ERROR' },
    ],
  }] } };
  const result = await rejectionDiagnostics(new Response(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'PRIVATE_BODY' }, providerMetadata: { gateway } }), { status: 429 }));
  assert.deepEqual(result.requestIdentifier, { source: 'providerMetadata.gateway.generationId', value: gateway.generationId });
  assert.equal(result.gatewayGenerationId, gateway.generationId);
  assert.deepEqual(result.providerErrors, [{ provider: 'anthropic', statusCode: 503, category: 'service_unavailable' }, { provider: 'anthropic', statusCode: 429 }]);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  const budget = await rejectionDiagnostics(new Response(JSON.stringify({ error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached', secret: 'PRIVATE' } } }), { status: 429 }));
  assert.equal(budget.providerErrorCode, 'enforced_spend_limit_reached');
  const hostile = await rejectionDiagnostics(new Response(JSON.stringify({ error: { details: { error_code: 'PRIVATE' } }, providerMetadata: { gateway: { generationId: 'PRIVATE', routing: { modelAttempts: [{ providerAttempts: [{ provider: 'anthropic', success: false, statusCode: '503', error: 'PRIVATE' }] }] } } } }), { status: 429 }));
  assert.equal(hostile.providerErrors, undefined); assert.equal(hostile.gatewayGenerationId, undefined); assert.equal(hostile.providerErrorCode, undefined);
});
