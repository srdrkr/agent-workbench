import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubAndWriteReport } from '../scripts/request-status-verifier.js';

/**
 * Regression coverage for the report.json scrub ordering. The verifier's
 * safety net is only meaningful if scrubAndWriteReport is the single, final
 * write to report.json and its leak check inspects the evidence directory
 * as it stands at that point — not a snapshot from an earlier write.
 */

test('scrubAndWriteReport leaves a scrubbed report.json on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-scrub-order-'));
  try {
    const secret = `SYNTH_SECRET_${randomBytes(4).toString('hex')}`;
    const report = { note: `owner secret was ${secret}`, nested: { value: secret } };

    const result = await scrubAndWriteReport(dir, report, [secret]);

    const onDisk = await readFile(join(dir, 'report.json'), 'utf8');
    assert.equal(onDisk.includes(secret), false, 'final report.json must not contain the raw secret');
    assert.notEqual(result.ok, false, 'a report with no real leak must not be marked failed');

    const scrubCheck = JSON.parse(await readFile(join(dir, 'scrub-check.json'), 'utf8'));
    assert.equal(scrubCheck.leaks.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scrubAndWriteReport detects a leak still present in the evidence dir at check time and fails the report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-scrub-order-'));
  try {
    const secret = `SYNTH_SECRET_${randomBytes(4).toString('hex')}`;
    // A stray unscrubbed artifact left behind by something other than the
    // final write (e.g. a leftover log) — the leak check must still catch
    // it because it inspects the FINAL on-disk state, not just the text it
    // just wrote.
    await writeFile(join(dir, 'stray-leftover.log'), `debug dump: ${secret}\n`);

    const report = { ok: true, note: 'otherwise clean report body' };
    const result = await scrubAndWriteReport(dir, report, [secret]);

    assert.equal(result.ok, false, 'a detected leak must flip ok to false');
    assert.ok(result.scrubFailure && result.scrubFailure.leaks.length >= 1);

    const scrubCheck = JSON.parse(await readFile(join(dir, 'scrub-check.json'), 'utf8'));
    assert.ok(scrubCheck.leaks.some(l => l.files.some(f => f.includes('stray-leftover.log'))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
