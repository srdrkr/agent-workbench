import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitDecisionHistory } from '../app/utils/decision-history.js';

const ACTIVE = '2026-09-19T10:00:00.000Z';
const EARLIER = '2026-09-01T10:00:00.000Z';
const OLDEST = '2026-08-01T10:00:00.000Z';

function record(id, contextRevision, extra = {}) {
  return { id, contextRevision, message: `Request ${id}`, status: 'awaiting_approval', ...extra };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

test('mixed revisions are grouped by strict equality with the active revision', () => {
  const records = [record('a', ACTIVE), record('b', EARLIER), record('c', ACTIVE), record('d', OLDEST), record('e', EARLIER)];
  const { current, historical } = splitDecisionHistory(records, ACTIVE);
  assert.deepEqual(current.map(r => r.id), ['a', 'c']);
  assert.deepEqual(historical.map(r => r.id), ['b', 'd', 'e']);
  assert.equal(current.length + historical.length, records.length);
  // Same record objects, not copies, so historical records stay inspectable as stored.
  assert.equal(current[0], records[0]);
  assert.equal(historical[0], records[1]);
});

test('empty input yields two empty groups', () => {
  assert.deepEqual(splitDecisionHistory([], ACTIVE), { current: [], historical: [] });
  assert.deepEqual(splitDecisionHistory(undefined, ACTIVE), { current: [], historical: [] });
  assert.deepEqual(splitDecisionHistory(null, ACTIVE), { current: [], historical: [] });
});

test('current-only input keeps every record current and the history empty', () => {
  const records = [record('a', ACTIVE), record('b', ACTIVE), record('c', ACTIVE)];
  const { current, historical } = splitDecisionHistory(records, ACTIVE);
  assert.deepEqual(current.map(r => r.id), ['a', 'b', 'c']);
  assert.deepEqual(historical, []);
});

test('history-only input leaves the current group empty', () => {
  const records = [record('a', EARLIER), record('b', OLDEST), record('c', EARLIER)];
  const { current, historical } = splitDecisionHistory(records, ACTIVE);
  assert.deepEqual(current, []);
  assert.deepEqual(historical.map(r => r.id), ['a', 'b', 'c']);
});

test('ordering inside each group matches the original order, whatever the interleaving', () => {
  const ids = [];
  const records = [];
  for (let i = 0; i < 40; i += 1) {
    const revision = [ACTIVE, EARLIER, ACTIVE, ACTIVE, OLDEST][i % 5];
    ids.push({ id: `r${i}`, revision });
    records.push(record(`r${i}`, revision));
  }
  const { current, historical } = splitDecisionHistory(records, ACTIVE);
  assert.deepEqual(current.map(r => r.id), ids.filter(x => x.revision === ACTIVE).map(x => x.id));
  assert.deepEqual(historical.map(r => r.id), ids.filter(x => x.revision !== ACTIVE).map(x => x.id));
  // A second call over the same input is deterministic.
  assert.deepEqual(splitDecisionHistory(records, ACTIVE), { current, historical });
});

test('equality is strict: a revision that differs only by type is historical', () => {
  const records = [record('num', 7), record('str', '7')];
  const { current, historical } = splitDecisionHistory(records, 7);
  assert.deepEqual(current.map(r => r.id), ['num']);
  assert.deepEqual(historical.map(r => r.id), ['str']);
});

test('records without a revision, or non-object entries, are never treated as current', () => {
  const missing = record('missing', undefined);
  delete missing.contextRevision;
  const { current, historical } = splitDecisionHistory([missing, null, record('ok', ACTIVE)], ACTIVE);
  assert.deepEqual(current.map(r => r.id), ['ok']);
  assert.deepEqual(historical, [missing, null]);
});

test('inputs are not mutated and the returned groups are fresh arrays', () => {
  const records = deepFreeze([record('a', ACTIVE, { proposal: { title: 'Keep', citations: ['brief'] } }), record('b', EARLIER), record('c', ACTIVE)]);
  const snapshot = JSON.stringify(records);
  const first = splitDecisionHistory(records, ACTIVE);
  const second = splitDecisionHistory(records, ACTIVE);
  assert.equal(JSON.stringify(records), snapshot);
  assert.equal(records.length, 3);
  assert.notEqual(first.current, records);
  assert.notEqual(first.historical, records);
  assert.notEqual(first.current, second.current);
  assert.notEqual(first.historical, second.historical);
  first.current.push(record('x', ACTIVE));
  first.historical.length = 0;
  assert.equal(records.length, 3);
  assert.deepEqual(second.current.map(r => r.id), ['a', 'c']);
  assert.deepEqual(second.historical.map(r => r.id), ['b']);
});
