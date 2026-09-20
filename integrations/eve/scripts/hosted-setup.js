import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { databasePool } from '../hosted/store.js';
import { setupHosted } from '../hosted/setup.js';
function privateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('PRIVATE_FILE_REQUIRED'); return JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
let pool;
try {
  if (!process.env.WORKBENCH_HOSTED_SETUP_FILE) throw new Error('SETUP_FILE_REQUIRED');
  const input = privateJson(process.env.WORKBENCH_HOSTED_SETUP_FILE);
  pool = databasePool(process.env.DATABASE_URL);
  const result = await setupHosted(pool, { ...input, origin: process.env.APP_ORIGIN, secret: process.env.BETTER_AUTH_SECRET });
  console.log(JSON.stringify(result));
} catch { console.error('Hosted setup did not complete. Inspect configured resources privately; do not retry with different credentials or an increased budget.'); process.exitCode = 1; }
finally { await pool?.end(); }
