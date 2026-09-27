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

// Matches a writeFile(join(<dir>, 'report.json')) call site, regardless of
// where in the file it appears.
const WRITE_REPORT_JSON = /writeFile\(\s*join\(\s*\w+\s*,\s*['"]report\.json['"]\s*\)/g;

function matchingBraceEnd(source, fromIndex) {
  const open = source.indexOf('{', fromIndex);
  assert.ok(open >= 0, 'expected an opening brace after fromIndex');
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('unbalanced braces while scanning for function end');
}

// This is a structural guard, not a behavioural one: it does not run the
// verifier at all. It exists because the behavioural tests below only
// exercise scrubAndWriteReport in isolation, so they would keep passing even
// if main() (or the --netns parent path) grew back a second, unscrubbed
// write to report.json after scrubAndWriteReport already ran its leak check
// — which is exactly the bug this file was added to catch. Scanning the
// source for every writeFile(...report.json...) call site and requiring
// there be exactly one, living inside scrubAndWriteReport, catches that
// regression regardless of where in main() it's reintroduced.
test('report.json has exactly one writer in the source: scrubAndWriteReport', async () => {
  const verifierPath = new URL('../scripts/request-status-verifier.js', import.meta.url);
  const source = await readFile(verifierPath, 'utf8');

  const matches = [...source.matchAll(WRITE_REPORT_JSON)];
  assert.equal(
    matches.length,
    1,
    `expected exactly one writeFile(...report.json...) call site, found ${matches.length}. ` +
      'A second one (e.g. a raw rewrite reinserted into main() after runOnce()) would let an ' +
      'unscrubbed report.json reach disk after the leak check already ran.'
  );

  const fnStart = source.indexOf('export async function scrubAndWriteReport');
  assert.ok(fnStart >= 0, 'scrubAndWriteReport must still be exported');
  const fnEnd = matchingBraceEnd(source, fnStart);
  const [writeCall] = matches;
  assert.ok(
    writeCall.index > fnStart && writeCall.index < fnEnd,
    'the sole report.json write must live inside scrubAndWriteReport, not in main() or the ' +
      '--netns parent path, where it would bypass the leak check'
  );
});

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
