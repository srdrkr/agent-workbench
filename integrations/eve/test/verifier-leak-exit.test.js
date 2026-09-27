import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildNetnsWrapperScript } from '../scripts/request-status-verifier.js';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/request-status-verifier.js', import.meta.url));

/**
 * Regression coverage for a leak discovered late (during scrub-order's own
 * leak check, or a stray artifact from elsewhere) actually failing the run:
 * the persisted report.json must say ok:false, and the process must exit
 * non-zero, on both the plain path and the --netns re-exec path. Drives the
 * real CLI (main()) via the EVE_RSV_TEST_STUB=leak seam, which plants an
 * unscrubbed secret in the evidence dir and calls the real
 * scrubAndWriteReport — no browser needed.
 */

async function runVerifier(args, env) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout || '' };
  }
}

test('a leak found during scrub yields persisted report.json ok:false and a non-zero exit (plain path)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eve-verifier-leak-'));
  try {
    const secret = `SYNTH_LEAK_${randomBytes(4).toString('hex')}`;
    const { code } = await runVerifier(
      ['--evidence', dir, '--skip-build'],
      { EVE_RSV_TEST_STUB: 'leak', EVE_RSV_TEST_STUB_SECRET: secret }
    );
    assert.notEqual(code, 0, 'a detected leak must exit non-zero');

    const onDiskText = await readFile(join(dir, 'report.json'), 'utf8');
    assert.equal(onDiskText.includes(secret), false, 'the persisted report must be scrubbed of the raw secret');
    const report = JSON.parse(onDiskText);
    assert.equal(report.ok, false, 'persisted report.json must reflect the leak, not an earlier ok:true snapshot');
    assert.ok(report.scrubFailure && report.scrubFailure.leaks.length >= 1, 'persisted report must record the leak');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a leak found during scrub yields persisted report.json ok:false and a non-zero exit (--netns path)', async (t) => {
  try {
    await execFileAsync('unshare', ['-rn', 'true']);
  } catch {
    t.skip('unshare -rn is unavailable in this environment');
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), 'eve-verifier-leak-netns-'));
  // `ip` itself need not be genuinely functional for this case: the stub
  // seam never touches the network, so a no-op `ip` that just reports
  // success is enough to exercise the real re-exec/wrapper/exit-code path
  // without depending on this host having a working `ip` binary.
  const fakeBinDir = await mkdtemp(join(tmpdir(), 'eve-fake-ip-'));
  try {
    const fakeIp = join(fakeBinDir, 'ip');
    await writeFile(fakeIp, '#!/bin/sh\nexit 0\n');
    await chmod(fakeIp, 0o755);

    const secret = `SYNTH_LEAK_${randomBytes(4).toString('hex')}`;
    const { code } = await runVerifier(
      ['--evidence', dir, '--netns', '--skip-build'],
      {
        PATH: `${fakeBinDir}:${process.env.PATH}`,
        EVE_RSV_TEST_STUB: 'leak',
        EVE_RSV_TEST_STUB_SECRET: secret,
      }
    );
    assert.notEqual(code, 0, 'a detected leak under --netns must exit non-zero, not be masked by the wrapper');

    const onDiskText = await readFile(join(dir, 'report.json'), 'utf8');
    assert.equal(onDiskText.includes(secret), false, 'the persisted report must be scrubbed of the raw secret');
    const report = JSON.parse(onDiskText);
    assert.equal(report.ok, false, 'persisted report.json must reflect the leak under --netns too');
    assert.ok(report.scrubFailure && report.scrubFailure.leaks.length >= 1, 'persisted report must record the leak');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(fakeBinDir, { recursive: true, force: true });
  }
});

test('netns wrapper script forwards the inner command\'s exit code, not echo\'s', async () => {
  const fakeBinDir = await mkdtemp(join(tmpdir(), 'eve-fake-ip-wrapper-'));
  try {
    const fakeIp = join(fakeBinDir, 'ip');
    await writeFile(fakeIp, '#!/bin/sh\nexit 0\n');
    await chmod(fakeIp, 0o755);

    for (const innerExit of [0, 1, 7]) {
      // A subprocess invocation, like the real inner command (a spawned node
      // child), not a shell `exit` builtin: `exit` would terminate the
      // wrapper script immediately and never reach the trailing `echo` at
      // all, which would pass even with the masking bug present and defeat
      // the point of this test.
      const script = buildNetnsWrapperScript(`bash -c "exit ${innerExit}"`);
      const code = await new Promise((resolvePromise) => {
        const child = spawn('bash', ['-c', script], {
          env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        child.on('exit', resolvePromise);
      });
      assert.equal(code, innerExit, `wrapper exit code must match the inner command's exit (${innerExit}), not be masked by the trailing echo`);
    }
  } finally {
    await rm(fakeBinDir, { recursive: true, force: true });
  }
});

test('netns wrapper script still fails loudly when the loopback check itself fails', async () => {
  const fakeBinDir = await mkdtemp(join(tmpdir(), 'eve-fake-failing-ip-'));
  try {
    const fakeIp = join(fakeBinDir, 'ip');
    await writeFile(fakeIp, '#!/bin/sh\nexit 1\n');
    await chmod(fakeIp, 0o755);

    const script = buildNetnsWrapperScript('exit 0');
    const { code, stderr } = await new Promise((resolvePromise) => {
      const child = spawn('bash', ['-c', script], {
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
      });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', (c) => resolvePromise({ code: c, stderr: err }));
    });
    assert.equal(code, 1, 'a failing loopback check must exit non-zero without running the inner command');
    assert.match(stderr, /--netns: could not bring up loopback/);
  } finally {
    await rm(fakeBinDir, { recursive: true, force: true });
  }
});
