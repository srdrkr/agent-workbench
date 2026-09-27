import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const eveRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('verify:request-status browser command exits 0 and writes scrubbed report', { timeout: 300_000 }, async (t) => {
  const evidence = await mkdtemp(join(tmpdir(), 'eve-rsv-test-'));
  t.after(() => rm(evidence, { recursive: true, force: true }));
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(eveRoot, 'scripts/request-status-verifier.js'), '--evidence', evidence], {
      cwd: eveRoot,
      env: { HOME: process.env.HOME, PATH: process.env.PATH, CI: 'true' },
      stdio: 'inherit',
    });
    child.on('exit', resolve);
  });
  assert.equal(code, 0);
  const report = JSON.parse(await readFile(join(evidence, 'report.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.ok(report.scenarios.every(s => s.ok));
  assert.deepEqual(report.scenarios.map(s => s.name), ['start-finish-request', 'blocked-request', 'held-rejected-review-recovery', 'held-uncertain-review-blocked']);
  assert.equal(report.secretsScrubNote.includes('never written'), true);
  const scrub = JSON.parse(await readFile(join(evidence, 'scrub-check.json'), 'utf8'));
  assert.equal(scrub.leaks.length, 0);
});
