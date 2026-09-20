import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Steward } from './steward.js';
import { demoJudge, demoFire, demoReader } from './steward-demo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const asset = name => readFileSync(join(root, 'web', name));
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const nonce = () => randomBytes(32).toString('hex');
const json = (response, code, body) => { response.writeHead(code, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
async function body(request) {
  let value = '';
  for await (const chunk of request) {
    value += chunk;
    if (Buffer.byteLength(value) > 16384) throw new Error('Request is too large');
  }
  return value;
}

export function createStewardServer({ steward, ownerKey, port, evidence = null }) {
  const sessions = new Map(); const tickets = new Map();
  const expires = () => Date.now() + 8 * 60 * 60000;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const authority = `127.0.0.1:${server.address()?.port ?? port}`;
    const origin = `http://${authority}`;
    if (req.headers.host !== authority) return json(res, 403, { error: 'Unrecognized host' });
    const path = req.url;
    try {
      for (const [key, value] of sessions) if (value.expiresAt < Date.now()) sessions.delete(key);
      for (const [key, value] of tickets) if (value < Date.now()) tickets.delete(key);
      if (path === '/api/launch' && req.method === 'POST') {
        if (!equal(req.headers.authorization, `Bearer ${ownerKey}`)) return json(res, 401, { error: 'Local owner authentication required' });
        if (tickets.size > 8) return json(res, 429, { error: 'Too many pending launches' });
        const ticket = nonce(); tickets.set(ticket, Date.now() + 30000);
        return json(res, 200, { ticket });
      }
      if (path === '/launch' && req.method === 'POST') {
        const ticket = new URLSearchParams(await body(req)).get('ticket');
        if (!ticket || !tickets.has(ticket) || tickets.get(ticket) < Date.now()) return json(res, 401, { error: 'Launch expired; run npm run steward:open again' });
        tickets.delete(ticket);
        const sessionId = nonce(); sessions.set(sessionId, { csrf: nonce(), expiresAt: expires() });
        res.setHeader('Set-Cookie', `workbench_owner=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        res.writeHead(303, { Location: '/' }); return res.end();
      }
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
        const name = path === '/' ? 'index.html' : path.slice(1);
        res.setHeader('Content-Type', name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript' : 'text/css');
        return res.end(asset(name));
      }
      const token = (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith('workbench_owner='))?.slice(16);
      const session = sessions.get(token);
      if (!session) return json(res, 401, { error: 'Open an owner session with npm run steward:open' });
      if (path === '/api/state' && req.method === 'GET') return json(res, 200, { ...steward.view(), csrf: session.csrf, observedResult: evidence });
      if (req.method !== 'POST' || req.headers.origin !== origin ||
        req.headers['content-type'] !== 'application/json' || !equal(req.headers['x-workbench-csrf'], session.csrf)) return json(res, 403, { error: 'Owner session and same-origin action required' });
      const input = JSON.parse(await body(req));
      let result;
      if (path === '/api/propose') result = await steward.propose(input);
      else if (path === '/api/approve') result = steward.approve(input.requestId, { proposalHash: input.proposalHash, owner: 'local-owner' });
      else if (path === '/api/dispatch') result = await steward.dispatch(input.requestId,
        { proposalHash: input.proposalHash, owner: 'local-owner' }, demoFire(input.lostResponse === true));
      else if (path === '/api/reconcile') {
        const record = steward.request(input.requestId);
        if (!record.taskId) throw new Error('No coding handoff');
        result = await steward.probe.reconcile(record.taskId, demoReader(steward.probe.get(record.taskId)));
      } else if (path === '/api/stop') result = steward.probe.stop();
      else if (path === '/api/logout') { sessions.delete(token); res.setHeader('Set-Cookie', 'workbench_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); result = { signedOut: true }; }
      else return json(res, 404, { error: 'Unknown action' });
      return json(res, 200, result);
    } catch {
      // Never expose raw provider, filesystem, JSON, or SQL errors to the browser.
      return json(res, 400, { error: 'Action rejected. Refresh the view and check proposal, context, approval, and admission state.' });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const { values } = parseArgs({ options: { port: { type: 'string', default: '4317' },
    runtime: { type: 'string', default: '.runtime/steward' }, project: { type: 'string' },
    'eve-fixture-token-file': { type: 'string' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const runtime = resolve(values.runtime); mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const keyPath = join(runtime, 'owner-key');
  try { writeFileSync(keyPath, nonce(), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const info = lstatSync(keyPath);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Owner key must be a private regular file');
  let judge = demoJudge; let judgeName = 'scripted demo';
  if (values['eve-fixture-token-file']) {
    if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('The optional Eve adapter requires Node 24+');
    const tokenPath = resolve(values['eve-fixture-token-file']);
    const tokenInfo = lstatSync(tokenPath);
    if (!tokenInfo.isFile() || tokenInfo.isSymbolicLink() || (tokenInfo.mode & 0o077) || tokenInfo.size > 4096) throw new Error('Eve fixture token must be a private regular file');
    const { createEveJudge } = await import('../integrations/eve/judge.js');
    judge = await createEveJudge({ enabled: true, host: 'http://127.0.0.1:2000', authToken: readFileSync(tokenPath, 'utf8').trim() });
    judgeName = 'Eve fixture';
  }
  const steward = new Steward(join(runtime, 'state.sqlite'), { judge, judgeName });
  if (values.project || !steward.db.prepare('SELECT id FROM steward_project LIMIT 1').get()) {
    steward.importProject(JSON.parse(readFileSync(values.project ?? join(root, 'fixtures/steward-project.json'), 'utf8')));
  }
  const server = createStewardServer({ steward, ownerKey: readFileSync(keyPath, 'utf8'), port,
    evidence: JSON.parse(readFileSync(join(root, 'fixtures/observed-result.json'), 'utf8')) });
  server.listen(port, '127.0.0.1', () => console.log(`Project Steward at http://127.0.0.1:${port}. ${judgeName}; synthetic coding only. Open with npm run steward:open.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { steward.close(); process.exit(0); }));
}
