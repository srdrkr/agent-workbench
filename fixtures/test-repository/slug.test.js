import test from 'node:test';
import assert from 'node:assert/strict';
import { slug } from './slug.js';

test('existing behavior', () => {
  assert.equal(slug('Hello World'), 'hello-world');
  assert.equal(slug(''), '');
  assert.equal(slug('already-slugged'), 'already-slugged');
});
test('trim whitespace and collapse separator runs', () => {
  assert.equal(slug('  Hello   World  '), 'hello-world');
  assert.equal(slug('\tHello\nWorld\t'), 'hello-world');
  assert.equal(slug('Hello---World'), 'hello-world');
  assert.equal(slug('Hello - World'), 'hello-world');
});
