import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

// Transfer a one-use launch ticket through a private local form, never a URL, log, or command argument.
process.umask(0o077);
const { values } = parseArgs({ options: { port: { type: 'string', default: '4317' }, runtime: { type: 'string', default: '.runtime/steward' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/launch`, { method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${readFileSync(join(resolve(values.runtime), 'owner-key'), 'utf8')}` } });
  if (!response.ok) throw new Error();
  const { ticket } = await response.json();
  if (!/^[a-f0-9]{64}$/.test(ticket)) throw new Error();
  const directory = mkdtempSync(join(tmpdir(), 'workbench-launch-'));
  const path = join(directory, 'open.html');
  writeFileSync(path, `<!doctype html><meta name="referrer" content="no-referrer"><title>Opening Project Steward</title><form method="post" action="http://127.0.0.1:${port}/launch"><input type="hidden" name="ticket" value="${ticket}"><button>Open Project Steward</button></form><script>document.forms[0].submit()</script>`, { mode: 0o600 });
  const result = spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [path], { stdio: 'ignore' });
  if (result.status !== 0) { rmSync(directory, { recursive: true, force: true }); throw new Error(); }
  console.log('Opened a local owner session. No credentials were printed.');
  setTimeout(() => rmSync(directory, { recursive: true, force: true }), 31000);
} catch { console.error('Could not open Steward. Start the local server and check the runtime directory.'); process.exitCode = 1; }
