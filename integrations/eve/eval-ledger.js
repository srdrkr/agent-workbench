import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, openSync } from 'node:fs';

export const EVAL_MODEL = 'anthropic/claude-opus-5';
export const EVAL_CASE_IDS = ['next-step', 'commitment', 'conflict', 'injection', 'unsupported-progress'];
export function caseIdsForSet(caseSet) {
  if (caseSet === 'all') return [...EVAL_CASE_IDS];
  if (caseSet === 'remaining') return EVAL_CASE_IDS.slice(1);
  throw new Error('EVAL_CASE_SET_INVALID');
}
export function validateCaseBudget(caseSet, budgetMicros) {
  validateBudget(budgetMicros);
  caseIdsForSet(caseSet);
  // This prepared packet retains 467740 micro-USD from the three prior runs.
  // The remaining ceiling constrains local admission; it grants no live authority.
  if (caseSet === 'remaining' && budgetMicros > 532260) throw new Error('EVAL_BUDGET_INVALID');
}
export const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

export function openLedger(path, { readOnly = false } = {}) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('EVAL_LEDGER_NOT_PRIVATE');
  } finally { closeSync(fd); }
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA busy_timeout=5000;');
  if (!readOnly) db.exec('PRAGMA synchronous=FULL;');
  return db;
}

export function validateBudget(budgetMicros) {
  if (!Number.isSafeInteger(budgetMicros) || budgetMicros <= 0 || budgetMicros > 1_000_000) throw new Error('EVAL_BUDGET_INVALID');
}

export function initializeLedger(path, { project, cases, mode, fixtureHash, budgetMicros = 1_000_000, caseSet = 'all' }) {
  validateCaseBudget(caseSet, budgetMicros);
  if (JSON.stringify(cases.map(item => item.id)) !== JSON.stringify(caseIdsForSet(caseSet))) throw new Error('EVAL_CASE_SET_INVALID');
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { fsyncSync(fd); } finally { closeSync(fd); }
  const db = openLedger(path);
  try {
    db.exec(`CREATE TABLE run (id INTEGER PRIMARY KEY CHECK(id=1), model TEXT NOT NULL, mode TEXT NOT NULL,
      fixture_hash TEXT NOT NULL, budget_micros INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, case_set TEXT NOT NULL);
      CREATE TABLE cases (id TEXT PRIMARY KEY, ordinal INTEGER UNIQUE NOT NULL, expected_kind TEXT NOT NULL,
      message TEXT NOT NULL, message_hash TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT UNIQUE,
      reserved_micros INTEGER NOT NULL DEFAULT 0, request_bytes INTEGER, request_hash TEXT,
      provider_intent_at TEXT, http_status INTEGER, result TEXT, evidence TEXT, rejection TEXT);`);
    db.prepare('INSERT INTO run VALUES (1,?,?,?,?,?,?,?)').run(EVAL_MODEL, mode, fixtureHash, budgetMicros, 'prepared', now(), caseSet);
    for (const [ordinal, item] of cases.entries()) {
      const message = JSON.stringify({ request: item.request, project, commitments: [], evalCaseId: item.id });
      db.prepare('INSERT INTO cases(id,ordinal,expected_kind,message,message_hash,status) VALUES (?,?,?,?,?,?)')
        .run(item.id, ordinal, item.expectedKind, message, hash(message), 'prepared');
    }
  } finally { db.close(); }
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function beginCase(db, id) {
  return transaction(db, () => {
    const record = db.prepare('SELECT * FROM cases WHERE id=?').get(id);
    const run = db.prepare('SELECT * FROM run').get();
    if (!record || !['prepared', 'active'].includes(run.status) || record.status !== 'prepared'
        || db.prepare("SELECT COUNT(*) AS n FROM cases WHERE ordinal<? AND status!='completed'").get(record.ordinal).n) {
      throw new Error('EVAL_CASE_HELD');
    }
    db.prepare("UPDATE cases SET status='create_intent' WHERE id=?").run(id);
    db.prepare("UPDATE run SET status='active'").run();
    return record;
  });
}

export function admitProvider(path, { caseId, sessionId, messageHash, body, mode }) {
  const bytes = Buffer.byteLength(body);
  // Conservative text-only allowance: one token per UTF-8 JSON byte plus
  // 2,048 framing tokens. $10/M includes the higher one-hour cache-write rate;
  // output includes reasoning, capped at 2,048 tokens at $25/M.
  const reserve = (bytes + 2048) * 10 + 2048 * 25;
  const db = openLedger(path);
  try {
    transaction(db, () => {
      const run = db.prepare('SELECT * FROM run').get();
      const record = db.prepare('SELECT * FROM cases WHERE id=?').get(caseId);
      const totals = db.prepare('SELECT SUM(reserved_micros) AS reserved, COUNT(*) AS calls FROM cases WHERE reserved_micros>0').get();
      if (run.model !== EVAL_MODEL || run.mode !== mode || run.status !== 'active'
          || !record || record.status !== 'create_intent' || record.message_hash !== messageHash
          || record.reserved_micros || (record.session_id && record.session_id !== sessionId)
          || totals.calls >= 5 || bytes > 12_000 || reserve + (totals.reserved ?? 0) > run.budget_micros) {
        throw new Error('EVAL_PROVIDER_ADMISSION_DENIED');
      }
      db.prepare(`UPDATE cases SET session_id=?,reserved_micros=?,request_bytes=?,request_hash=?,provider_intent_at=? WHERE id=?`)
        .run(sessionId, reserve, bytes, hash(body), now(), caseId);
    });
  } finally { db.close(); }
}

export function caseReceipt(db, id, { sessionId, status, result, evidence }) {
  transaction(db, () => {
    const old = db.prepare('SELECT * FROM cases WHERE id=?').get(id);
    if (!old || old.status !== 'create_intent' || (old.session_id && sessionId && old.session_id !== sessionId)) throw new Error('EVAL_RECEIPT_INVALID');
    db.prepare('UPDATE cases SET session_id=COALESCE(session_id,?), status=?,result=?,evidence=? WHERE id=?')
      .run(sessionId ?? null, status, result ? JSON.stringify(result) : null, JSON.stringify(evidence ?? {}), id);
    if (status !== 'completed') db.prepare("UPDATE run SET status='held'").run();
  });
}

export function ledgerSummary(db) {
  // Read old evidence without schema migration or writes to historical runs.
  const hasRejection = db.prepare('PRAGMA table_info(cases)').all().some(column => column.name === 'rejection');
  const hasCaseSet = db.prepare('PRAGMA table_info(run)').all().some(column => column.name === 'case_set');
  const run = db.prepare('SELECT model,mode,status,fixture_hash AS fixtureHash,budget_micros AS budgetMicros FROM run').get();
  run.caseSet = hasCaseSet ? db.prepare('SELECT case_set FROM run').get().case_set : 'all';
  return { ...run, cases: db.prepare(`SELECT id,status,session_id AS sessionId,reserved_micros AS reservedMicros,
    request_bytes AS requestBytes,http_status AS httpStatus,result,evidence,${hasRejection ? 'rejection' : 'NULL AS rejection'} FROM cases ORDER BY ordinal`).all()
    .map(row => ({ ...row, result: row.result ? JSON.parse(row.result) : null, evidence: row.evidence ? JSON.parse(row.evidence) : null,
      rejection: row.rejection ? JSON.parse(row.rejection) : null })) };
}
