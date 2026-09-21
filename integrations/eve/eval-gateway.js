import { Client } from 'eve/client';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { proposalSchema } from './schema.js';
import { judgmentObservation } from './stream-policy.js';
import { beginCase, caseReceipt, caseIdsForSet, EVAL_CASE_IDS, hash, initializeLedger, ledgerSummary, openLedger, validateCaseBudget } from './eval-ledger.js';

const integration = fileURLToPath(new URL('./', import.meta.url));
const repository = resolve(integration, '../..');
const isWithin = (parent, path) => { const p = relative(parent, path); return !p.startsWith('..') && !isAbsolute(p); };

function keyFromFile(path) {
  if (!isAbsolute(path) || isWithin(repository, realpathSync(path))) throw new Error('EVAL_KEY_LOCATION_INVALID');
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)) throw new Error('EVAL_KEY_NOT_PRIVATE');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) || info.size < 20 || info.size > 4096) throw new Error('EVAL_KEY_NOT_PRIVATE');
    const key = readFileSync(fd, 'utf8').trim();
    if (/\s/.test(key) || key.length < 20) throw new Error('EVAL_KEY_INVALID');
    return key;
  } finally { closeSync(fd); }
}

function safeEvidence(events) {
  const steps = events.filter(event => event.type === 'step.completed').map(event => {
    const usage = {};
    for (const key of ['costUsd', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      const value = event.data.usage?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[key] = value;
    }
    const id = event.data.providerMetadata?.gateway?.generationId;
    return { usage, ...(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(id) ? { generationId: id } : {}) };
  });
  return { steps, usageSource: 'eve_step_completed', costObserved: steps.some(step => step.usage.costUsd !== undefined) };
}

/** Keep useful rejection evidence without persisting raw provider error text. */
export function inspectEvalResult(result, reservedMicros) {
  const events = result.events;
  const parsed = proposalSchema.safeParse(result.data);
  const evidence = safeEvidence(events);
  const completion = {
    sessionStatus: ['waiting', 'completed', 'failed'].includes(result.status) ? result.status : 'other',
    schemaValid: parsed.success,
    turnCompleted: events.some(event => event.type === 'turn.completed'),
    resultCompleted: events.some(event => event.type === 'result.completed'),
    failedEventTypes: [...new Set(events.filter(event => ['step.failed', 'turn.failed', 'session.failed'].includes(event.type)).map(event => event.type))],
    stepLimitReached: events.some(event => event.type === 'step.failed' && event.data?.message === 'JUDGE_STEP_LIMIT'),
  };
  const observedMicros = evidence.steps.reduce((sum, step) => sum + (step.usage.costUsd ?? 0) * 1_000_000, 0);
  const heldReasons = [
    ...(!['waiting', 'completed'].includes(result.status) ? ['session_not_completed'] : []),
    ...(!parsed.success ? ['output_schema_invalid'] : []),
    ...(!completion.turnCompleted ? ['turn_not_completed'] : []),
    ...(!completion.resultCompleted ? ['result_not_completed'] : []),
    ...(completion.failedEventTypes.length ? ['runtime_failed'] : []),
    ...(!reservedMicros ? ['provider_admission_missing'] : []),
    ...(observedMicros > reservedMicros ? ['cost_reservation_exceeded'] : []),
  ];
  return { completed: heldReasons.length === 0, proposal: parsed.success ? parsed.data : null,
    evidence: { ...evidence, completion, heldReasons } };
}

/** Persist scope rejection before another case can acquire provider authority. */
export function recordScopedResult(db, item, { sessionId, proposal, evidence }, project) {
  const candidate = project.codingCandidates.find(candidate => candidate.id === proposal.candidateId);
  const scopeValid = proposal.citations.every(id => project.sources.some(source => source.id === id))
    && (proposal.kind === 'coding' ? Boolean(candidate && candidate.sourceIds.every(id => proposal.citations.includes(id))) : proposal.candidateId === null)
    && (proposal.kind === 'clarify' ? proposal.question !== null : proposal.question === null);
  caseReceipt(db, item.id, { sessionId, status: scopeValid ? 'completed' : 'held', result: proposal,
    evidence: { ...evidence, expectedKind: item.expectedKind, kindMatches: proposal.kind === item.expectedKind,
      scopeValid, heldReasons: [...evidence.heldReasons, ...(!scopeValid ? ['output_scope_invalid'] : [])],
      rubricReview: 'pending_evidence_review' } });
  return scopeValid;
}

export async function runGatewayEval({ runDir, keyFile, mock = false, timeoutMs = 60_000, budgetMicros = 1_000_000, caseSet = 'all' }) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('EVAL_REQUIRES_NODE_24');
  validateCaseBudget(caseSet, budgetMicros);
  const selectedIds = caseIdsForSet(caseSet);
  process.umask(0o077);
  const directory = resolve(runDir);
  const ledgerPath = join(directory, 'run.sqlite');
  // The same run directory never starts again, including after a crash before
  // the first receipt. Reconciliation is read-only; no resume or retry option.
  await mkdir(directory, { mode: 0o700 });
  const evalBytes = readFileSync(join(repository, 'fixtures/steward-evals.json'), 'utf8');
  const projectBytes = readFileSync(join(repository, 'fixtures/steward-project.json'), 'utf8');
  const prepared = JSON.parse(evalBytes);
  const project = JSON.parse(projectBytes);
  if (prepared.cases.length !== 5 || prepared.cases.some((item, i) => item.id !== EVAL_CASE_IDS[i])
      || project.sources.some(source => source.exposure !== 'model_allowed')
      || project.codingCandidates.some(candidate => candidate.spec.mode !== 'synthetic')) throw new Error('EVAL_FIXTURES_INVALID');
  project.revision = hash(projectBytes);
  const cases = prepared.cases.filter(item => selectedIds.includes(item.id));
  initializeLedger(ledgerPath, { project, cases, mode: mock ? 'mock' : 'live', fixtureHash: hash(evalBytes + projectBytes), budgetMicros, caseSet });
  const db = openLedger(ledgerPath);
  let child;
  let exited;
  try {
    const key = mock ? null : keyFromFile(keyFile);
    const work = await mkdtemp(join(tmpdir(), 'workbench-gateway-eval-'));
    for (const path of ['agent', 'package.json', 'bounded-model.js', 'eval-ledger.js', 'eval-transport.js', 'rejection-diagnostics.js', 'gateway-request.js', 'hosted', 'shared']) {
      await cp(join(integration, path), join(work, path), { recursive: true });
    }
    await symlink(join(integration, 'node_modules'), join(work, 'node_modules'));
    const accessToken = randomBytes(32).toString('hex');
    const port = await new Promise((accept, reject) => {
      const server = createServer(); server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => accept(port)); });
    });
    const host = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [join(integration, 'node_modules/eve/bin/eve.js'), 'dev', '--no-ui', '--host', '127.0.0.1', '--port', String(port)], {
      cwd: work, env: { PATH: process.env.PATH, TMPDIR: tmpdir(),
        EVE_TELEMETRY_DISABLED: '1', EVE_TRACES: 'off', EVE_TRACES_CONTENT: 'off',
        WORKBENCH_EVE_MODE: mock ? 'gateway-eval-mock' : 'gateway-eval',
        WORKBENCH_EVE_ACCESS_TOKEN: accessToken, WORKBENCH_EVE_EVAL_LEDGER: ledgerPath,
        ...(key ? { AI_GATEWAY_API_KEY: key } : {}),
      }, stdio: ['ignore', 'ignore', 'ignore'], detached: true,
    });
    let ended = false;
    exited = new Promise(done => { child.once('exit', () => { ended = true; done(); }); child.once('error', () => { ended = true; done(); }); });
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (ended) throw new Error('EVAL_RUNTIME_UNAVAILABLE');
      try { ready = (await fetch(`${host}/eve/v1/health`, { signal: AbortSignal.timeout(500) })).ok; } catch { /* Read-only startup check. */ }
      if (ready) break;
      await delay(250);
    }
    if (!ready) throw new Error('EVAL_RUNTIME_UNAVAILABLE');
    const client = new Client({ host, auth: { bearer: accessToken }, redirect: 'error' });
    for (const item of cases) {
      const record = beginCase(db, item.id);
      let sessionId;
      try {
        const { response } = await client.sessions.create({ message: record.message, outputSchema: proposalSchema,
          ...judgmentObservation(timeoutMs) });
        sessionId = response.sessionId;
        db.prepare('UPDATE cases SET session_id=COALESCE(session_id,?) WHERE id=?').run(sessionId, item.id);
        const result = await response.result();
        const reserved = db.prepare('SELECT reserved_micros FROM cases WHERE id=?').get(item.id).reserved_micros;
        const { completed, proposal, evidence } = inspectEvalResult(result, reserved);
        if (!completed) {
          caseReceipt(db, item.id, { sessionId, status: 'held', evidence }); break;
        }
        if (!recordScopedResult(db, item, { sessionId, proposal, evidence }, project)) break;
      } catch {
        caseReceipt(db, item.id, { sessionId, status: 'unknown', evidence: { failure: 'EVAL_CASE_OUTCOME_UNKNOWN' } });
        break;
      }
    }
    if (db.prepare("SELECT COUNT(*) AS n FROM cases WHERE status='completed'").get().n === cases.length) db.prepare("UPDATE run SET status='completed'").run();
    return ledgerSummary(db);
  } catch {
    db.prepare("UPDATE run SET status='held'").run();
    throw new Error('EVAL_RUN_HELD');
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ }
      await Promise.race([exited, delay(3000)]);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
    }
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'run-dir': { type: 'string' }, 'key-file': { type: 'string' },
      mock: { type: 'boolean', default: false }, status: { type: 'boolean', default: false },
      'budget-micros': { type: 'string', default: '1000000' }, 'case-set': { type: 'string', default: 'all' } } });
    if (!values['run-dir'] || (!values.mock && !values.status && !values['key-file'])) throw new Error('EVAL_ARGUMENTS_REQUIRED');
    if (values.status) {
      const db = openLedger(join(resolve(values['run-dir']), 'run.sqlite'), { readOnly: true });
      try { console.log(JSON.stringify(ledgerSummary(db), null, 2)); } finally { db.close(); }
    } else console.log(JSON.stringify(await runGatewayEval({ runDir: values['run-dir'], keyFile: values['key-file'], mock: values.mock,
      budgetMicros: Number(values['budget-micros']), caseSet: values['case-set'] }), null, 2));
  } catch { console.error('EVAL_STOPPED. Inspect the private run ledger; do not retry with a new run directory.'); process.exitCode = 1; }
}
