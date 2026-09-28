import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Regression coverage for the entry-point check in request-status-verifier.js:
 * it must compare real paths, not the literal argv[1] string, so launching
 * the script through a symlink still runs main() instead of silently
 * exiting 0 without doing anything.
 */
test('running the verifier via a symlink still executes main()', async () => {
  const target = fileURLToPath(new URL('../scripts/request-status-verifier.js', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'eve-verifier-symlink-'));
  const link = join(dir, 'verifier-link.js');
  try {
    await symlink(target, link);
    const { stdout } = await execFileAsync(process.execPath, [link, '--help']);
    assert.match(stdout, /Usage: node scripts\/request-status-verifier\.js/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
