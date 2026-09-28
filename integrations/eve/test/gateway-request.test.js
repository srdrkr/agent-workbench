import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { codeReviewSchema } from '../schema.js';
import { endpoint, gatewayRequest } from '../gateway-request.js';
import { HOSTED_MODEL } from '../hosted/transport.js';

function wireSchema(inputSchema) {
  const { serialized } = gatewayRequest(endpoint, { method: 'POST', headers: { 'ai-language-model-id': HOSTED_MODEL },
    body: JSON.stringify({ maxOutputTokens: 2048, prompt: [{ role: 'user', content: 'Synthetic review' }],
      tools: [{ type: 'function', name: 'final_output', inputSchema }] }) }, HOSTED_MODEL);
  const tool = JSON.parse(serialized).tools[0];
  assert.equal(tool.strict, true);
  assert.ok(!/"(?:minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf)":/.test(serialized));
  return tool.inputSchema;
}

test('actual review schema sends compatible integer lines while local validation keeps positive safe integers', () => {
  const original = z.toJSONSchema(codeReviewSchema);
  const schema = wireSchema(original);
  const line = schema.properties.findings.items.properties.line;
  assert.equal(line.type, 'integer');
  assert.match(line.description, /greater than 0/);
  assert.match(line.description, /Maximum value \(inclusive\): 9007199254740991/);
  assert.deepEqual(schema.required, ['verdict', 'summary', 'findings']);
  assert.equal(schema.properties.findings.items.additionalProperties, false);
  assert.deepEqual(original, z.toJSONSchema(codeReviewSchema));
  const review = line => ({ verdict: 'correct', summary: 'Fix this finding',
    findings: [{ path: 'example.js', line, problem: 'Synthetic problem' }] });
  for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, '1', null]) {
    assert.equal(codeReviewSchema.safeParse(review(invalid)).success, false, `Invalid line: ${invalid}`);
  }
  assert.equal(codeReviewSchema.safeParse(review(1)).success, true);
});

test('nested numeric bounds become descriptions including zero, exclusive bounds, and multiples', () => {
  const schema = z.strictObject({ readings: z.array(z.number().min(0).max(10).multipleOf(2).describe('Reading.').nullable()),
    fraction: z.number().gt(0).lt(1) });
  const wire = wireSchema(z.toJSONSchema(schema));
  const reading = wire.properties.readings.items.anyOf[0];
  assert.equal(reading.type, 'number');
  assert.match(reading.description, /^Reading\./);
  assert.match(reading.description, /Minimum value \(inclusive\): 0/);
  assert.match(reading.description, /Maximum value \(inclusive\): 10/);
  assert.match(reading.description, /multiple of 2/);
  assert.equal(wire.properties.readings.items.anyOf[1].type, 'null');
  assert.match(wire.properties.fraction.description, /greater than 0/);
  assert.match(wire.properties.fraction.description, /less than 1/);
  assert.equal(schema.safeParse({ readings: [0, 2, null], fraction: 0.5 }).success, true);
  for (const invalid of [{ readings: [-2], fraction: 0.5 }, { readings: [12], fraction: 0.5 },
    { readings: [3], fraction: 0.5 }, { readings: [2], fraction: 0 }, { readings: [2], fraction: 1 }]) {
    assert.equal(schema.safeParse(invalid).success, false);
  }
});
