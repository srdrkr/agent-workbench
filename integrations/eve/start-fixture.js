import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const integration = fileURLToPath(new URL('./', import.meta.url));
const repository = resolve(integration, '../..');

function privateDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw new Error('FIXTURE_RUNTIME_UNAVAILABLE'); }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('FIXTURE_RUNTIME_NOT_PRIVATE');
}

function privateToken(path) {
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, randomBytes(32).toString('hex')); } finally { closeSync(fd); }
  } catch (error) { if (error.code !== 'EEXIST') throw new Error('FIXTURE_TOKEN_UNAVAILABLE'); }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) || info.size !== 64) throw new Error();
    const value = readFileSync(fd, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error();
    return value;
  } catch { throw new Error('FIXTURE_TOKEN_NOT_PRIVATE'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function startFixture({ runtime = join(repository, '.runtime', 'steward'), port = 2000 } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('FIXTURE_REQUIRES_NODE_24');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('FIXTURE_INVALID_PORT');
  // Never attach to an unknown process or rotate a key while it may be in use.
  await new Promise((accept, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('FIXTURE_PORT_UNAVAILABLE')));
    probe.listen(port, '127.0.0.1', () => probe.close(accept));
  });
  const rootRuntime = join(repository, '.runtime');
  privateDirectory(rootRuntime);
  if (runtime === join(rootRuntime, 'steward')) privateDirectory(runtime);
  else {
    // Alternate runtime directories are for isolated tests, and must exist.
    const info = lstatSync(runtime);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('FIXTURE_RUNTIME_NOT_PRIVATE');
  }
  const tokenPath = join(runtime, 'eve-key');
  const token = privateToken(tokenPath);
  const child = spawn(process.execPath, [join(integration, 'node_modules/eve/bin/eve.js'), 'dev', '--no-ui', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: integration,
    env: {
      PATH: process.env.PATH, TMPDIR: tmpdir(),
      EVE_TELEMETRY_DISABLED: '1', EVE_TRACES: 'off', EVE_TRACES_CONTENT: 'off',
      WORKBENCH_EVE_MODE: 'fixture', WORKBENCH_EVE_ACCESS_TOKEN: token,
    },
    stdio: ['ignore', 'ignore', 'ignore'], detached: true,
  });
  let ended = false;
  const exited = new Promise(resolveExit => {
    child.once('exit', () => { ended = true; resolveExit(); });
    child.once('error', () => { ended = true; resolveExit(); });
  });
  const stop = async () => {
    if (child.pid && !ended) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ }
      await Promise.race([exited, delay(3000)]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
    }
  };
  try {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (ended) throw new Error('FIXTURE_SERVER_START_FAILED');
      try {
        const response = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok && !ended) return { tokenPath, stop, exited };
      } catch { /* Bounded read-only startup check. */ }
      await delay(250);
    }
    throw new Error('FIXTURE_SERVER_START_FAILED');
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    const fixture = await startFixture();
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void fixture.stop(); });
    console.log('Eve fixture ready at http://127.0.0.1:2000. No model-provider calls.');
    console.log('Start the root server with --eve-fixture-token-file .runtime/steward/eve-key, then run npm run steward:open.');
    await fixture.exited;
  } catch (error) {
    const safe = new Set(['FIXTURE_REQUIRES_NODE_24', 'FIXTURE_INVALID_PORT', 'FIXTURE_PORT_UNAVAILABLE', 'FIXTURE_RUNTIME_NOT_PRIVATE', 'FIXTURE_RUNTIME_UNAVAILABLE', 'FIXTURE_TOKEN_NOT_PRIVATE', 'FIXTURE_TOKEN_UNAVAILABLE', 'FIXTURE_SERVER_START_FAILED']);
    console.error(safe.has(error.message) ? error.message : 'FIXTURE_START_FAILED');
    process.exitCode = 1;
  }
}
