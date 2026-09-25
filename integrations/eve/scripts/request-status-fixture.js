/**
 * Test-only loopback fixture for the hosted Project Steward request/status UI.
 *
 * Serves the real Nuxt SPA client assets (from build:hosted / .nuxt/dist/client)
 * and routes /api/* to the REAL hostedHandler (ownerAuth + HostedSteward + HostedStore
 * on PGlite TestPool). Only the judge/provider boundary is stubbed.
 *
 * Exclusions (explicit): production Nitro/Vercel function assembly, live AI Gateway,
 * live Postgres, Telegram, coding dispatch, follow-through.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { TestPool } from '../test/pg-fixture.js';
import { HostedStore } from '../hosted/store.js';
import { HostedSteward } from '../hosted/steward.js';
import { HOSTED_MODEL } from '../hosted/transport.js';
import { ownerAuth } from '../hosted/auth.js';
import { hostedHandler } from '../hosted/http.js';
import { setupHosted } from '../hosted/setup.js';
import { HostedCoding } from '../hosted/coding.js';

const here = dirname(fileURLToPath(import.meta.url));
const eveRoot = resolve(here, '..');
const repoRoot = resolve(eveRoot, '../..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export const PROPOSAL_OK = Object.freeze({
  kind: 'commitment',
  candidateId: null,
  title: 'Confirm the normalization priority',
  rationale: 'The brief already names whitespace normalization as the current priority.',
  citations: ['brief'],
  question: null,
});

function isLoopbackHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0.0.0.0';
}

function parseTarget(input, options = {}) {
  if (typeof input === 'string') {
    try { return new URL(input); } catch { return null; }
  }
  if (input && typeof input === 'object') {
    if (typeof input.href === 'string') {
      try { return new URL(input.href); } catch { /* fall through */ }
    }
    const host = input.host || input.hostname || options.hostname || options.host;
    if (host) {
      const port = input.port || options.port || '';
      const proto = input.protocol || options.protocol || 'http:';
      try { return new URL(`${proto}//${host}${port ? `:${port}` : ''}/`); } catch { return null; }
    }
  }
  if (options.host || options.hostname) {
    try {
      return new URL(`${options.protocol || 'http:'}//${options.hostname || options.host}${options.port ? `:${options.port}` : ''}/`);
    } catch { return null; }
  }
  return null;
}

export async function resolveClientAssets(root = eveRoot) {
  // Prefer `nuxt generate` public output: includes index.html with window.__NUXT__.config
  // required by the SPA client (ssr: false). build:hosted Vercel output alone is insufficient
  // without Nitro's HTML shell.
  const publicDir = join(root, '.output/public');
  const indexPath = join(publicDir, 'index.html');
  await access(indexPath);
  await access(join(publicDir, '_nuxt'));
  const html = await readFile(indexPath, 'utf8');
  if (!html.includes('window.__NUXT__') || !html.includes('/_nuxt/')) {
    throw new Error('SPA_INDEX_INVALID');
  }
  return { clientDir: publicDir, indexHtml: html, title: 'Project Steward' };
}

export function installNodeNetworkGuards(originUrl, record) {
  const origin = new URL(originUrl);
  const allowedPort = origin.port || (origin.protocol === 'https:' ? '443' : '80');
  const previous = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpsRequest: https.request,
    netConnect: net.connect,
  };

  const deny = (kind, detail) => {
    const entry = { at: new Date().toISOString(), kind, detail: String(detail).slice(0, 300) };
    record.push(entry);
    throw new Error(`NODE_NETWORK_DENIED:${kind}:${detail}`);
  };

  const allowUrl = (url) => {
    if (!url) return false;
    if (url.protocol === 'data:' || url.protocol === 'blob:') return true;
    return isLoopbackHost(url.hostname) && String(url.port || allowedPort) === String(allowedPort);
  };

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' || input instanceof URL
      ? new URL(String(input), origin)
      : new URL(input.url, origin);
    if (!allowUrl(url)) deny('fetch', url.href);
    return previous.fetch.call(globalThis, input, init);
  };

  const wrapRequest = (orig, label) => function guardedRequest(...args) {
    let options = {};
    let u = null;
    if (typeof args[0] === 'string' || args[0] instanceof URL) {
      u = parseTarget(args[0], typeof args[1] === 'object' ? args[1] : {});
      options = typeof args[1] === 'object' && args[1] ? args[1] : {};
    } else if (typeof args[0] === 'object' && args[0]) {
      options = args[0];
      u = parseTarget(args[0], options);
    }
    if (!u || !allowUrl(u)) deny(label, u?.href || JSON.stringify(options).slice(0, 200));
    return orig.apply(this, args);
  };

  http.request = wrapRequest(previous.httpRequest, 'http.request');
  https.request = wrapRequest(previous.httpsRequest, 'https.request');

  net.connect = function guardedConnect(...args) {
    let host; let port;
    if (typeof args[0] === 'number') { port = args[0]; host = args[1]; }
    else if (typeof args[0] === 'object' && args[0]) { port = args[0].port; host = args[0].host || args[0].hostname; }
    else if (typeof args[0] === 'string') {
      // path form for IPC — deny
      deny('net.connect', args[0]);
    }
    const h = host || '127.0.0.1';
    if (!isLoopbackHost(h)) deny('net.connect', `${h}:${port}`);
    return previous.netConnect.apply(this, args);
  };

  return {
    coverage: {
      nodeFetchGuard: true,
      nodeHttpGuard: true,
      nodeHttpsGuard: true,
      nodeNetConnectGuard: true,
    },
    restore() {
      globalThis.fetch = previous.fetch;
      http.request = previous.httpRequest;
      https.request = previous.httpsRequest;
      net.connect = previous.netConnect;
    },
  };
}

export async function createControllableJudge(store, { now = () => new Date().toISOString() } = {}) {
  const events = new EventEmitter();
  let gate = null;
  let outcome = PROPOSAL_OK;
  let calls = 0;
  let lastInput = null;

  const resetGate = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    gate = { promise, resolve };
  };
  resetGate();

  const judge = async (input) => {
    calls += 1;
    await store.change(state => {
      const record = state.requests[input.hostedRequestId];
      if (!record) throw new Error('JUDGE_RECORD_MISSING');
      if (!record.provider) {
        record.provider = {
          intentAt: now(),
          httpStatus: 200,
          sessionId: `synthetic-session-${calls}`,
          reservedMicros: 1,
        };
        state.reservedMicros += 1;
      }
    });
    lastInput = input;
    events.emit('called', { input, calls });
    await gate.promise;
    const current = outcome;
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'function') return current(input);
    if (current && current.__throw) throw current.__throw;
    return current;
  };

  return {
    judge,
    events,
    get calls() { return calls; },
    get lastInput() { return lastInput; },
    hold() { resetGate(); },
    async waitUntilCalled({ timeoutMs = 15000, atLeast = 1 } = {}) {
      if (calls >= atLeast) return { calls };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          events.off('called', onCalled);
          reject(new Error('JUDGE_CALL_TIMEOUT'));
        }, timeoutMs);
        const onCalled = (payload) => {
          if (calls >= atLeast) {
            clearTimeout(timer);
            events.off('called', onCalled);
            resolve(payload);
          }
        };
        events.on('called', onCalled);
      });
    },
    release(value = PROPOSAL_OK) {
      outcome = value;
      gate.resolve();
    },
    releaseHeld() {
      outcome = undefined;
      gate.resolve();
    },
    releaseThrow(error = new Error('synthetic-judge-failure')) {
      outcome = { __throw: error };
      gate.resolve();
    },
  };
}

export async function startRequestStatusFixture({
  pgDir,
  staticRoot,
  budgetMicros = 1_000_000,
  projectPath = join(repoRoot, 'fixtures/steward-project.json'),
  project: projectOverride = null,
  // Optional synthetic coding connection: a fixed spec, an in-memory repository reader
  // and an in-process Routine recorder. Nothing leaves the process.
  coding: codingOptions = null,
  clockStart = null,
} = {}) {
  if (!pgDir) throw new Error('PG_DIR_REQUIRED');
  const assets = await resolveClientAssets(eveRoot);
  const clientDir = staticRoot || assets.clientDir;
  const html = assets.indexHtml;
  const project = projectOverride ? structuredClone(projectOverride) : JSON.parse(await readFile(projectPath, 'utf8'));
  // Deterministic application clock: fixed start, real elapsed time, explicit advances.
  const clockBase = clockStart ? Date.parse(clockStart) - Date.now() : 0;
  let clockAdvance = 0;
  const now = () => new Date(Date.now() + clockBase + clockAdvance).toISOString();
  const codingSends = [];
  const ownerEmail = `owner-${randomBytes(8).toString('hex')}@example.com`;
  const password = `pw-${randomBytes(24).toString('base64url')}`;
  const secret = randomBytes(32).toString('base64url');
  const blockedNode = [];
  const blockedBrowser = [];

  const pool = new TestPool(pgDir);
  // Bind origin after listen — auth needs exact origin. Bootstrap with placeholder then recreate auth? 
  // better-auth baseURL must match. So listen first with a temporary handler? 
  // Pattern: createServer, listen(0), then build origin, then setup.

  let handler = null;
  let origin = null;
  let steward = null;
  let store = null;
  let judgeControl = null;
  let networkGuard = null;
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host || `127.0.0.1`;
      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        if (!handler) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'FIXTURE_NOT_READY' }));
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyBuf = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) value.forEach(v => headers.append(key, v));
          else headers.set(key, value);
        }
        // Ensure origin header for POSTs if browser omitted oddly
        const request = new Request(origin + url.pathname + url.search, {
          method: req.method,
          headers,
          body: ['GET', 'HEAD'].includes(req.method || 'GET') ? undefined : bodyBuf,
          duplex: 'half',
        });
        const response = await handler(request);
        res.statusCode = response.status;
        const setCookies = typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : [];
        const skip = new Set(['set-cookie', 'content-encoding', 'transfer-encoding']);
        response.headers.forEach((value, key) => {
          if (skip.has(key.toLowerCase())) return;
          res.setHeader(key, value);
        });
        if (setCookies.length) res.setHeader('set-cookie', setCookies);
        const buf = Buffer.from(await response.arrayBuffer());
        res.end(buf);
        return;
      }

      // Static SPA
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      const rel = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
      const filePath = join(clientDir, rel);
      if (!filePath.startsWith(clientDir) || !existsSync(filePath)) {
        // SPA fallback
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
        return;
      }
      const type = MIME[extname(filePath)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      createReadStream(filePath).pipe(res);
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'FIXTURE_SERVER_ERROR', message: String(error?.message || error).slice(0, 200) }));
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const addr = server.address();
  origin = `http://127.0.0.1:${addr.port}`;

  networkGuard = installNodeNetworkGuards(origin, blockedNode);

  await setupHosted(pool, {
    origin,
    secret,
    ownerEmail,
    password,
    project,
    budgetMicros,
  });
  store = new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id });
  judgeControl = await createControllableJudge(store, { now });
  const coding = codingOptions ? new HostedCoding(store, {
    now, read: codingOptions.read,
    config: { spec: codingOptions.spec, repeatable: true, verifiedUntil: codingOptions.verifiedUntil, token: 'synthetic-routine-token-never-sent' },
    send: async payload => { codingSends.push({ at: now(), routineId: payload.routineId, text: payload.text }); return { outcome: 'accepted' }; },
  }) : null;
  steward = new HostedSteward(store, judgeControl.judge, { now, coding });
  if (coding) {
    const review = await steward.reviewPilot({ budgetMicros, maxProviderAttempts: 50 });
    await steward.approvePilot({ reviewHash: review.reviewHash });
  }
  const auth = ownerAuth(pool, { origin, secret });
  handler = hostedHandler({ auth, steward, ownerEmail, origin });

  const credentials = { email: ownerEmail, password, secret };
  // credentials stay in-process only; callers must not write them into shared artifacts

  return {
    origin,
    port: addr.port,
    projectId: project.id,
    assets,
    judge: judgeControl,
    steward,
    store,
    pool,
    /** @deprecated do not log — in-process only */
    _credentials: credentials,
    getOwnerLogin() { return { email: ownerEmail, password }; },
    codingSends,
    now,
    advanceClock(ms) { clockAdvance += ms; return now(); },
    blockedNode,
    blockedBrowser,
    networkCoverage() {
      return {
        browserGuard: true,
        nodeFetchGuard: networkGuard.coverage.nodeFetchGuard,
        nodeHttpGuard: networkGuard.coverage.nodeHttpGuard,
        nodeHttpsGuard: networkGuard.coverage.nodeHttpsGuard,
        nodeNetConnectGuard: networkGuard.coverage.nodeNetConnectGuard,
        netns: false, // filled by verifier if used
        blockedRequests: [...blockedBrowser, ...blockedNode.map(e => ({ source: 'node', ...e }))],
        exclusions: [
          'production Nitro/Vercel function wrapper',
          'live AI Gateway / Anthropic transport',
          'live Postgres',
          'Telegram',
          codingOptions ? 'live coding dispatch (Routine fire replaced by an in-process recorder; GitHub reads by a static synthetic reader)' : 'coding dispatch',
          'follow-through',
        ],
      };
    },
    browserRouteHandler: async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') {
        await route.continue();
        return;
      }
      if (url.origin === origin) {
        await route.continue();
        return;
      }
      const entry = { at: new Date().toISOString(), source: 'browser', url: url.href, method: req.method() };
      blockedBrowser.push(entry);
      await route.abort('blockedbyclient');
      throw new Error(`BROWSER_NETWORK_DENIED:${url.href}`);
    },
    async close() {
      await new Promise(resolveClose => server.close(resolveClose));
      networkGuard?.restore();
      await pool.end();
    },
  };
}

export function scrubArtifactText(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

export { eveRoot, repoRoot };
