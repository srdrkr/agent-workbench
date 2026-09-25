import { createHash } from 'node:crypto';
import { attemptLimit } from './continuation.js';

// Held-attempt recovery. Classification uses only facts Steward recorded itself:
// the transport's intent/reservation, the HTTP status, and the category parsed from
// the provider's error body. An HTTP status or model statement alone is never enough.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error(code); };
const terminal = new Set(['blocked', 'finished']);
const own = (object, key) => Object.hasOwn(object ?? {}, key) ? object[key] : undefined;
// Documented pre-execution refusals: the status and parsed body category must agree.
const refusals = { 400: ['invalid_request_error'], 401: ['authentication_error'], 403: ['permission_error', 'forbidden'],
  404: ['not_found', 'not_found_error', 'model_not_found'], 413: ['request_too_large'],
  429: ['rate_limit_exceeded', 'rate_limit_error'], 503: ['overloaded_error', 'api_error'], 529: ['overloaded_error'] };
const dollars = micros => `$${(micros / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
const fresh = (project, now) => project.sources.every(s => Date.parse(s.observedAt) <= Date.parse(now) && Date.parse(s.expiresAt) > Date.parse(now));

function evidenceOf(record) {
  const p = record.provider; const r = p?.rejection;
  return { intentAt: p?.intentAt ?? null, sessionId: p?.sessionId ?? null, reservedMicros: p?.reservedMicros ?? 0,
    httpStatus: p?.httpStatus ?? null, errorCategory: r?.errorCategory ?? null, providerErrorCode: r?.providerErrorCode ?? null,
    requestIdentifier: r?.requestIdentifier?.value ?? null, completedAt: record.completedAt ?? null };
}

function authorityProblem(state, record, task, now) {
  if (record.purpose === 'coding_review') {
    const g = task?.followThrough?.grant;
    if (!g) return 'The task has no follow-through grant.';
    if (!(Date.parse(g.expiresAt) > Date.parse(now))) return `The task's follow-through grant expired at ${g.expiresAt} (UTC).`;
    if (g.contextRevision !== state.project.revision) return 'The project brief changed after this task was approved.';
  } else if (record.contextRevision !== state.project.revision) return 'The project brief changed after this request.';
  if (!fresh(state.project, now)) return 'The project brief has expired and needs a fresh owner-approved update.';
  return null;
}

/** Returns an owner-facing handoff for a held record, or null for any other status. */
export function heldRecovery(state, record, now) {
  if (record?.status !== 'held') return null;
  const e = evidenceOf(record); const p = record.provider;
  const coding = record.purpose === 'coding_review';
  const task = coding ? own(state.coding?.jobs, record.taskId) : undefined;
  const taskStopped = Boolean(task?.followThrough && terminal.has(task.followThrough.status));
  const what = coding ? 'the automatic code review' : 'this request';
  const reserved = `Its reservation of ${dollars(e.reservedMicros)} stays counted against the allowance.`;
  const base = { evidence: e, taskId: record.taskId ?? null, taskStatus: task?.followThrough?.status ?? null, taskReason: task?.followThrough?.reason ?? null };
  const blocked = (kind, fields) => ({ ...base, case: kind, action: 'none', acknowledgeHash: null, ...fields });

  if (!e.intentAt || !e.sessionId || !(e.reservedMicros > 0)) return blocked('unclassified', {
    whatHappened: `A held record exists for ${what}, but its send intent or reservation is incomplete.`,
    unknown: 'Whether a model request was sent at all.', whoActs: 'Operator',
    missing: 'Complete transport intent record (intent time, session and reservation).',
    nextStep: 'Keep this held. The operator must inspect the stored record and provider logs; Steward has no safe recovery for it.' });
  if (e.httpStatus === null) return blocked('uncertain_delivery', {
    whatHappened: `Steward reserved allowance and started ${what} at ${e.intentAt} (UTC), but no HTTP response was recorded.`,
    unknown: 'Whether the provider received, executed or billed the request, and what it returned.', whoActs: 'Operator with provider-account access',
    missing: 'A provider response or a provider usage record for this session. Steward cannot read provider usage (missing capability: session reconciliation).',
    nextStep: `Keep this held and do not retry. Check provider or gateway usage for session ${e.sessionId} around ${e.intentAt} (UTC). ${reserved}` });
  if (e.httpStatus >= 200 && e.httpStatus < 300) return blocked('unverified_output', {
    whatHappened: `The provider answered HTTP ${e.httpStatus} for ${what}, but Steward could not verify a valid result from it.`,
    unknown: 'Whether the model produced usable output. Raw output is not retained, so invalid output cannot be told apart from an interrupted response.',
    whoActs: 'Operator', missing: 'The validated model output or the validation failure reason; neither is stored.',
    nextStep: `Keep this held. The request was processed, so a replay could duplicate work. The operator must inspect provider logs for session ${e.sessionId}. ${reserved}` });
  const consistent = p.rejection?.httpStatus === e.httpStatus && typeof e.errorCategory === 'string' && Number.isFinite(Date.parse(record.completedAt));
  if (!consistent) return blocked('unclassified', {
    whatHappened: `The provider answered HTTP ${e.httpStatus} for ${what} without a recognized error body.`,
    unknown: 'Whether the request was refused before execution. The status code alone does not prove it.', whoActs: 'Operator',
    missing: 'A parsed provider error category that matches the HTTP status.',
    nextStep: `Keep this held. The operator must check provider logs for session ${e.sessionId}. ${reserved}` });

  const providerLimit = e.providerErrorCode === 'enforced_spend_limit_reached' || e.errorCategory === 'quota_for_entity_exceeded';
  const refused = providerLimit || (refusals[e.httpStatus] ?? []).includes(e.errorCategory);
  if (!refused) return blocked('unclassified', {
    whatHappened: `The provider answered HTTP ${e.httpStatus} (${e.errorCategory}) for ${what}.`,
    unknown: 'Whether any work was done before the failure. This category does not confirm a refusal before execution.', whoActs: 'Operator',
    missing: 'Evidence that the provider refused the request before executing it.',
    nextStep: `Keep this held. The operator must check provider logs for session ${e.sessionId}. ${reserved}` });

  const authority = authorityProblem(state, record, task, now);
  const localLimit = state.reservedMicros >= state.budgetMicros || Object.values(state.requests).filter(r => r.provider).length >= attemptLimit(state);
  const kind = providerLimit ? 'allowance_exhausted' : authority ? 'expired_authority' : localLimit ? 'allowance_exhausted' : 'confirmed_rejection';
  const whatHappened = `The provider refused ${what}: HTTP ${e.httpStatus}, ${e.providerErrorCode ?? e.errorCategory}. No ${coding ? 'review result' : 'proposal'} was produced.${coding && task?.followThrough?.reason ? ` The task's follow-through stopped: ${task.followThrough.reason}` : ''}`;
  const unknown = `Steward cannot read provider billing for this refusal. ${reserved}${coding ? ' The pull request itself is still unreviewed.' : ''}`;
  const after = kind === 'allowance_exhausted'
    ? (providerLimit ? 'The provider account spend limit refused it; only the account owner can change that, outside Steward. Steward will not refill or retry.' : 'Your pilot allowance is used up. Review the pilot allowance before any new request.')
    : kind === 'expired_authority' ? `${authority} The old grant is not resumed; update the brief and start a fresh request, which needs fresh approval.`
      : 'Then start a fresh request with a new request ID. Any new coding work needs its own scope approval.';
  if (!coding) {
    // Proposal requests keep the existing one-time retry policy; there is no acknowledgement for them.
    return blocked(kind, { whatHappened, unknown, whoActs: kind === 'confirmed_rejection' ? 'You (the owner)' : 'Operator',
      missing: kind === 'confirmed_rejection' ? null : 'Steward has no supported recovery for a held proposal request in this state.',
      nextStep: kind === 'confirmed_rejection' ? 'Use "Retry this request once" when it is offered. It resends this exact request once under the existing limits.'
        : `Keep this held. ${after} Clearing the hold needs an operator; there is no owner control for it.` });
  }
  if (!task?.followThrough) return blocked(kind, { whatHappened, unknown, whoActs: 'Operator',
    missing: 'The coding task record for this review is missing.', nextStep: 'Keep this held. The operator must inspect the stored task history; Steward cannot confirm the task stopped.' });
  if (!taskStopped) return blocked(kind, { whatHappened, unknown, whoActs: 'Steward follow-through, then you',
    missing: 'The task follow-through has not stopped yet.', nextStep: 'Wait for the next follow-through check to stop this task, then refresh. Acknowledgement is offered only after the task has stopped.' });
  const acknowledgeHash = hash({ id: record.id, purpose: record.purpose, taskId: record.taskId, headSha: record.headSha, inputHash: record.inputHash,
    contextRevision: record.contextRevision, judge: record.judge, completedAt: record.completedAt, provider: p, case: kind, taskStatus: task.followThrough.status });
  return { ...base, case: kind, action: 'acknowledge', acknowledgeHash, whatHappened, unknown, whoActs: 'You (the owner)', missing: null,
    nextStep: `Acknowledge this failed review. That keeps its history and reservation, sends nothing and does not retry or resume the task. ${after}` };
}

/** Owner acknowledgement of a confirmed, provider-refused coding review. It resolves only this
 * record's hold; it never retries, resumes a grant, refills allowance, or edits task history. */
export async function acknowledgeRejectedReview(store, input, now) {
  const { requestId, acknowledgeHash } = input ?? {};
  need(typeof requestId === 'string' && requestId.length <= 128 && typeof acknowledgeHash === 'string' && /^[a-f0-9]{64}$/.test(acknowledgeHash), 'INVALID_REQUEST');
  return store.change(state => {
    const record = own(state.requests, requestId);
    need(record, 'RECOVERY_REVIEW_STALE');
    if (record.status === 'rejection_acknowledged' && record.resolution?.acknowledgeHash === acknowledgeHash) return record;
    need(record.purpose === 'coding_review', 'RECOVERY_NOT_SUPPORTED');
    const recovery = heldRecovery(state, record, now);
    need(recovery, 'RECOVERY_REVIEW_STALE');
    const refusedCases = ['confirmed_rejection', 'expired_authority', 'allowance_exhausted'];
    need(recovery.acknowledgeHash === acknowledgeHash, recovery.action === 'acknowledge' ? 'RECOVERY_REVIEW_STALE'
      : refusedCases.includes(recovery.case) && recovery.taskStatus && !terminal.has(recovery.taskStatus) ? 'RECOVERY_TASK_ACTIVE' : 'RECOVERY_NOT_SUPPORTED');
    record.status = 'rejection_acknowledged';
    record.resolution = { kind: 'owner_acknowledged_rejection', at: now, acknowledgeHash, case: recovery.case, heldEvidence: recovery.evidence };
    state.events.push({ seq: state.events.length + 1, kind: 'held_rejection_acknowledged', at: now,
      data: { requestId, taskId: record.taskId, case: recovery.case, acknowledgeHash,
        retainedReservationMicros: record.provider.reservedMicros, totalReservedMicros: state.reservedMicros } });
    return record;
  });
}
