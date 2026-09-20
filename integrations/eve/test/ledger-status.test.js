import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeLedger, openLedger, ledgerSummary } from '../eval-ledger.js';

const repo = resolve(import.meta.dirname, '../../..');
const project = JSON.parse(readFileSync(join(repo, 'fixtures/steward-project.json'), 'utf8'));
const cases = JSON.parse(readFileSync(join(repo, 'fixtures/steward-evals.json'), 'utf8')).cases;
const cli = resolve(import.meta.dirname, '../eval-gateway.js');

test('read-only ledger connections reject writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'workbench-ledger-readonly-'));
  const path = join(dir, 'run.sqlite');
  try {
    initializeLedger(path, { project, cases, mode: 'mock', fixtureHash: 'synthetic' });
    const before = readFileSync(path);
    const db = openLedger(path, { readOnly: true });
    try {
      assert.equal(ledgerSummary(db).status, 'prepared');
      assert.throws(() => db.exec("UPDATE run SET status='completed'"), /readonly/i);
      assert.throws(() => db.exec('CREATE TABLE unexpected (id INTEGER)'), /readonly/i);
    } finally { db.close(); }
    assert.deepEqual(readFileSync(path), before);
    assert.deepEqual(await readdir(dir), ['run.sqlite']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('status CLI reads current and legacy held ledgers without changing evidence or starting a runtime', async () => {
  for (const legacy of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'workbench-ledger-status-'));
    const path = join(dir, 'run.sqlite');
    try {
      initializeLedger(path, { project, cases, mode: 'live', fixtureHash: 'synthetic' });
      const db = openLedger(path);
      try {
        db.exec("UPDATE run SET status='held'; UPDATE cases SET status='held', reserved_micros=123456 WHERE ordinal=0;");
        if (legacy) db.exec('ALTER TABLE cases DROP COLUMN rejection; ALTER TABLE run DROP COLUMN case_set;');
      } finally { db.close(); }
      await chmod(path, 0o400);
      const before = readFileSync(path);
      const result = spawnSync(process.execPath, [cli, '--status', '--run-dir', dir, '--key-file', join(dir, 'absent-key')],
        { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(result.stdout);
      assert.equal(summary.status, 'held');
      assert.equal(summary.caseSet, 'all');
      assert.equal(summary.cases[0].reservedMicros, 123456);
      assert.equal(summary.cases[0].rejection, null);
      assert.deepEqual(readFileSync(path), before);
      assert.deepEqual(await readdir(dir), ['run.sqlite']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});
