import { createHash } from 'node:crypto';
import { attemptLimit } from './continuation.js';

// Held-attempt recovery. Classification uses only facts Steward recorded itself:
// the transport's intent/reservation, the HTTP status, and parsed provider categories
// or a separately recorded owner observation. Status or model prose alone is insufficient.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error(code); };
const terminal = new Set(['blocked', 'finished']);
const own = (object, key) => Object.hasOwn(object ?? {}, key) ? object[key] : undefined;
// Documented pre-execution refusals: the status and parsed body category must agree.
const refusals = { 400: ['invalid_request_error'], 401: ['authentication_error'], 402: ['quota_for_entity_exceeded'], 403: ['permission_error', 'forbidden'],
  404: ['not_found', 'not_found_error', 'model_not_found'], 413: ['request_too_large'],
  429: ['rate_limit_exceeded', 'rate_limit_error'], 503: ['overloaded_error'], 529: ['overloaded_error'] };
const dollars = micros => `$${(micros / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
const fresh = (project, now) => project.sources.every(s => Date.parse(s.observedAt) <= Date.parse(now) && Date.parse(s.expiresAt) > Date.parse(now));

// Existing explicit proposal-retry policy. Sharing this predicate keeps the
// recovery handoff aligned with the actual button and server admission check.
export function rejectionReviewHash(record) {
  const p = record?.provider;
  if (record?.status !== 'held' || record.purpose !== undefined || !Number.isFinite(Date.parse(record.completedAt)) || record.retryRequestId
    || !p?.intentAt || !p.sessionId || !(p.reservedMicros > 0)
    || ![429, 503].includes(p.httpStatus) || p.rejection?.httpStatus !== p.httpStatus
    || !['rate_limit_exceeded', 'rate_limit_error', 'overloaded_error', 'api_error'].includes(p.rejection.errorCategory)
    || p.rejection.providerErrorCode === 'enforced_spend_limit_reached') return null;
  return hash({ id: record.id, inputHash: record.inputHash, contextRevision: record.contextRevision,
    judge: record.judge, completedAt: record.completedAt, provider: p });
}

// Operator observations stay separate from the original transport receipt.
// This narrow path supports legacy schema refusals whose category was discarded.
const cleanSchemaReceipt = p => p?.httpStatus === 400 && p.rejection?.httpStatus === 400
  && p.rejection.errorCategory == null && !p.rejection.providerErrorCode
  && !(p.rejection.providerErrors ?? []).some(e => e.provider !== 'anthropic' || e.statusCode !== 400 || e.category)
  && /^gen_[A-Za-z0-9]{8,80}$/.test(p.rejection.gatewayGenerationId ?? '');

export function rejectionObservationHash(state, record) {
  const p = record?.provider;
  const task = own(state.coding?.jobs, record?.taskId);
  const entries = task?.followThrough?.reviews?.filter(r => r.id === record.id && r.headSha === record.headSha) ?? [];
  if (record?.status !== 'held' || record.purpose !== 'coding_review' || record.rejectionObservation
    || record.projectId !== state.project.id || task?.projectId !== state.project.id || task.id !== record.taskId
    || !terminal.has(task.followThrough?.status) || !task.releasedAt
    || entries.length !== 1 || !['intent', 'unknown'].includes(entries[0].status)
    || !p?.intentAt || !p.sessionId || !(p.reservedMicros > 0) || !cleanSchemaReceipt(p)
    || !Number.isFinite(Date.parse(record.completedAt))) return null;
  return hash({ record, task, projectId: state.project.id });
}

export async function observeSchemaRejection(store, input, now) {
  const { requestId, observationHash, generationId, observedAt, reason, providerStatus, source } = input ?? {};
  need(typeof requestId === 'string' && requestId.length <= 128
    && typeof observationHash === 'string' && /^[a-f0-9]{64}$/.test(observationHash)
    && source === 'owner_provider_ui' && reason === 'unsupported_tool_schema' && providerStatus === 400
    && typeof generationId === 'string' && /^gen_[A-Za-z0-9]{8,80}$/.test(generationId)
    && typeof observedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt)
    && Number.isFinite(Date.parse(observedAt)) && new Date(observedAt).toISOString() === observedAt && Date.parse(observedAt) <= Date.parse(now), 'INVALID_REQUEST');
  return store.change(state => {
    const record = own(state.requests, requestId);
    need(record, 'RECOVERY_REVIEW_STALE');
    const observation = { source, reason, providerStatus, generationId, observedAt: new Date(observedAt).toISOString(), observationHash };
    if (record.rejectionObservation && Object.entries(observation).every(([key, value]) => record.rejectionObservation[key] === value)) return record;
    need(rejectionObservationHash(state, record) === observationHash
      && generationId === record.provider.rejection.gatewayGenerationId
      && Date.parse(observedAt) >= Date.parse(record.completedAt), 'RECOVERY_REVIEW_STALE');
    record.rejectionObservation = observation;
    state.events.push({ seq: state.events.length + 1, kind: 'schema_rejection_observed', at: now,
      data: { requestId, taskId: record.taskId, observation } });
    return record;
  });
}

// Limited to ordinary held requests, including drafting. Coding reviews and retry
// chains retain their existing recovery policy. Server observation cannot approve output.
function terminalRecoveryHash(state, record) {
  const p = record?.provider;
  if (record?.status !== 'held' || record.purpose !== undefined || record.retryOf || record.retryRequestId || record.proposal
    || ![undefined, 'assignment_draft'].includes(record.mode) || record.projectId !== state.project.id
    || !Number.isFinite(Date.parse(record.completedAt)) || !Number.isFinite(Date.parse(p?.intentAt))
    || !/^wrun_[A-Za-z0-9_]{8,100}$/.test(p?.sessionId ?? '') || !(p.reservedMicros > 0)
    || state.reservedMicros < p.reservedMicros || !(p.httpStatus >= 200 && p.httpStatus < 300)) return null;
  return hash({ record, projectId: state.project.id });
}
export const terminalObservationHash = (state, record) => record?.terminalObservation ? null : terminalRecoveryHash(state, record);
const terminalReceipt = (record, receipt, now) => receipt?.source === 'eve_session_stream'
  && receipt.sessionId === record.provider.sessionId && receipt.code === 'MODEL_SELECTION_FAILED'
  && receipt.reason === 'JUDGE_STEP_LIMIT' && receipt.eventCount === 8
  && Number.isFinite(Date.parse(receipt.terminalAt)) && Date.parse(receipt.terminalAt) >= Date.parse(record.provider.intentAt)
  && Date.parse(receipt.terminalAt) <= Date.parse(now);

export async function observeTerminalFailure(store, observe, input, now) {
  const { requestId, observationHash } = input ?? {};
  need(typeof requestId === 'string' && typeof observationHash === 'string' && /^[a-f0-9]{64}$/.test(observationHash), 'INVALID_REQUEST');
  const state = await store.read(); const record = own(state.requests, requestId);
  need(observe, 'RECOVERY_NOT_SUPPORTED');
  need(terminalObservationHash(state, record) === observationHash, 'RECOVERY_REVIEW_STALE');
  const receipt = await observe({ requestId, sessionId: record.provider.sessionId });
  need(terminalReceipt(record, receipt, now), 'RECOVERY_EVIDENCE_UNAVAILABLE');
  return store.change(current => {
    const r = own(current.requests, requestId);
    need(terminalObservationHash(current, r) === observationHash, 'RECOVERY_REVIEW_STALE');
    r.terminalObservation = { ...receipt, observedAt: now };
    current.events.push({ seq: current.events.length + 1, kind: 'terminal_judgment_failure_observed', at: now,
      data: { requestId, observation: r.terminalObservation } });
    return r;
  });
}

export async function acknowledgeTerminalFailure(store, observe, input, now) {
  const { requestId, acknowledgeHash } = input ?? {};
  need(typeof requestId === 'string' && typeof acknowledgeHash === 'string' && /^[a-f0-9]{64}$/.test(acknowledgeHash), 'INVALID_REQUEST');
  const state = await store.read(); const r = own(state.requests, requestId);
  if (r?.status === 'failure_acknowledged' && r.resolution?.acknowledgeHash === acknowledgeHash) return r;
  need(observe, 'RECOVERY_NOT_SUPPORTED');
  need(heldRecovery(state, r, now)?.acknowledgeHash === acknowledgeHash
    && terminalRecoveryHash(state, r), 'RECOVERY_REVIEW_STALE');
  // Recheck the current durable tail at acknowledgement. A resumed/changed session
  // revokes recovery instead of relying on a historical terminal observation.
  const receipt = await observe({ requestId, sessionId: r.provider.sessionId });
  need(terminalReceipt(r, receipt, now) && Object.entries(receipt).every(([k, v]) => r.terminalObservation[k] === v), 'RECOVERY_EVIDENCE_UNAVAILABLE');
  return store.change(current => {
    const record = own(current.requests, requestId);
    if (record?.status === 'failure_acknowledged' && record.resolution?.acknowledgeHash === acknowledgeHash) return record;
    const recovery = heldRecovery(current, record, now);
    need(recovery?.case === 'terminal_failure' && recovery.acknowledgeHash === acknowledgeHash, 'RECOVERY_REVIEW_STALE');
    record.status = 'failure_acknowledged';
    record.resolution = { kind: 'owner_acknowledged_terminal_failure', at: now, acknowledgeHash, case: recovery.case, heldEvidence: recovery.evidence };
    current.events.push({ seq: current.events.length + 1, kind: 'held_terminal_failure_acknowledged', at: now,
      data: { requestId, acknowledgeHash, retainedReservationMicros: record.provider.reservedMicros, totalReservedMicros: current.reservedMicros } });
    return record;
  });
}

function observedSchemaRefusal(record) {
  const o = record.rejectionObservation; const p = record.provider;
  return record.purpose === 'coding_review' && o?.source === 'owner_provider_ui' && o.reason === 'unsupported_tool_schema'
    && o.providerStatus === 400 && cleanSchemaReceipt(p)
    && o.generationId === p.rejection.gatewayGenerationId;
}

function evidenceOf(record) {
  const p = record.provider; const r = p?.rejection;
  return { ...(observedSchemaRefusal(record) ? { observation: record.rejectionObservation } : {}), intentAt: p?.intentAt ?? null, sessionId: p?.sessionId ?? null, reservedMicros: p?.reservedMicros ?? 0,
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
export function heldRecovery(state, record, now, { canObserve = true } = {}) {
  if (record?.status !== 'held') return null;
  const e = evidenceOf(record); const p = record.provider;
  const coding = record.purpose === 'coding_review';
  const task = coding ? own(state.coding?.jobs, record.taskId) : undefined;
  const taskStopped = Boolean(task?.followThrough && terminal.has(task.followThrough.status));
  const authority = authorityProblem(state, record, task, now);
  const localLimit = state.reservedMicros >= state.budgetMicros || Object.values(state.requests).filter(r => r.provider).length >= attemptLimit(state);
  const retryAfter = p?.rejection?.retryAfter;
  const retryAt = retryAfter?.kind === 'date' ? Date.parse(retryAfter.at)
    : retryAfter?.kind === 'seconds' ? Date.parse(record.completedAt) + retryAfter.seconds * 1000 : 0;
  const retryOffered = !coding && rejectionReviewHash(record) && !authority && !localLimit && !state.paused
    && record.projectId === state.project.id && record.judge === state.model && Object.keys(state.requests).length < 500
    && Number.isFinite(retryAt) && Date.parse(now) >= retryAt
    && !Object.values(state.requests).some(r => r !== record && ['held', 'thinking'].includes(r.status));
  const what = coding ? 'the automatic code review' : 'this request';
  const reserved = `Its reservation of ${dollars(e.reservedMicros)} stays counted against the allowance.`;
  const base = { evidence: e, canRetry: Boolean(retryOffered), taskId: record.taskId ?? null, taskStatus: task?.followThrough?.status ?? null, taskReason: task?.followThrough?.reason ?? null };
  const blocked = (kind, fields) => ({ ...base, case: kind, action: 'none', acknowledgeHash: null, ...fields,
    ...(retryOffered ? { whoActs: 'You (the owner)', missing: null,
      nextStep: 'The existing proposal retry policy offers "Retry this request once". It resends this exact request once under the existing limits; this does not prove the previous attempt did no work.' } : {}) });

  if (record.rejectionObservation && (!observedSchemaRefusal(record) || !task?.releasedAt)) return blocked('unclassified', {
    whatHappened: 'The saved owner observation no longer matches a released task and consistent schema refusal.',
    unknown: 'Whether the old observation still applies.', whoActs: 'Operator',
    missing: 'A released task and provider diagnostics consistent with the observed refusal.',
    nextStep: 'Keep this held. Reconcile the changed task or provider evidence before acknowledgement.' });
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
  const observationHash = terminalObservationHash(state, record);
  const terminalHash = terminalRecoveryHash(state, record);
  if (canObserve && terminalHash && terminalReceipt(record, record.terminalObservation, now)) return {
    ...base, case: 'terminal_failure', action: 'acknowledge',
    evidence: { ...e, terminalObservation: record.terminalObservation }, acknowledgeHash: terminalHash,
    whatHappened: 'The authenticated Eve session ended with MODEL_SELECTION_FAILED / JUDGE_STEP_LIMIT after its first model response. No completed result was recorded.',
    unknown: `The invalid-output reason is not available. The response may have incurred provider charges. ${reserved}`,
    whoActs: 'You (the owner)', missing: null,
    nextStep: 'Acknowledge the failed judgment. Steward rechecks the existing session, keeps the input and reservation, and sends no model request. Any fresh coding work needs its own exact scope approval.' };
  if (e.httpStatus >= 200 && e.httpStatus < 300) return { ...blocked('unverified_output', {
    whatHappened: `The provider answered HTTP ${e.httpStatus} for ${what}, but Steward could not verify a valid result from it.`,
    unknown: 'Whether the model produced usable output. Raw output is not retained, so invalid output cannot be told apart from an interrupted response.',
    whoActs: 'Operator', missing: 'The validated model output or the validation failure reason; neither is stored.',
    nextStep: `Keep this held. The request was processed, so a replay could duplicate work. The operator must inspect provider logs for session ${e.sessionId}. ${reserved}` }), ...(canObserve && observationHash ? { action: 'observe', observationHash, nextStep: 'Check the existing Eve session for a confirmed terminal failure. This reads its saved events and makes no model call. Unknown, ongoing or completed results remain held.' } : {}) };
  const consistent = p.rejection?.httpStatus === e.httpStatus && (typeof e.errorCategory === 'string' || observedSchemaRefusal(record)) && Number.isFinite(Date.parse(record.completedAt));
  if (!consistent) return blocked('unclassified', {
    whatHappened: `The provider answered HTTP ${e.httpStatus} for ${what} without a recognized error body.`,
    unknown: 'Whether the request was refused before execution. The status code alone does not prove it.', whoActs: 'Operator',
    missing: 'A parsed provider error category that matches the HTTP status.',
    nextStep: `Keep this held. The operator must check provider logs for session ${e.sessionId}. ${reserved}` });

  const providerLimit = (e.httpStatus === 402 && e.errorCategory === 'quota_for_entity_exceeded')
    || (e.providerErrorCode === 'enforced_spend_limit_reached'
      && ((e.httpStatus === 400 && e.errorCategory === 'invalid_request_error')
        || (e.httpStatus === 429 && ['rate_limit_error', 'rate_limit_exceeded'].includes(e.errorCategory))));
  const refused = observedSchemaRefusal(record) || (refusals[e.httpStatus] ?? []).includes(e.errorCategory);
  if (!refused) return blocked('unclassified', {
    whatHappened: `The provider answered HTTP ${e.httpStatus} (${e.errorCategory}) for ${what}.`,
    unknown: 'Whether any work was done before the failure. This category does not confirm a refusal before execution.', whoActs: 'Operator',
    missing: 'Evidence that the provider refused the request before executing it.',
    nextStep: `Keep this held. The operator must check provider logs for session ${e.sessionId}. ${reserved}` });

  const kind = providerLimit ? 'allowance_exhausted' : authority ? 'expired_authority' : localLimit ? 'allowance_exhausted' : 'confirmed_rejection';
  const whatHappened = `${observedSchemaRefusal(record) ? 'The owner observed this schema refusal in the provider UI. ' : ''}The provider refused ${what}: HTTP ${e.httpStatus}, ${observedSchemaRefusal(record) ? 'owner-observed unsupported tool schema' : e.providerErrorCode ?? e.errorCategory}. No ${coding ? 'review result' : 'proposal'} was produced.${coding && task?.followThrough?.reason ? ` The task's follow-through stopped: ${task.followThrough.reason}` : ''}`;
  const unknown = `Steward cannot read provider billing for this refusal. ${reserved}${coding ? ' The pull request itself is still unreviewed.' : ''}`;
  const after = kind === 'allowance_exhausted'
    ? (providerLimit ? 'The provider account spend limit refused it; only the account owner can change that, outside Steward. Steward will not refill or retry.' : 'Your pilot allowance is used up. Review the pilot allowance before any new request.')
    : kind === 'expired_authority' ? `${authority} The old grant is not resumed; update the brief and start a fresh request, which needs fresh approval.`
      : 'Then start a fresh request with a new request ID. Any new coding work needs its own scope approval.';
  if (!coding) {
    // Preserve the existing one-time retry policy, including its wait and authority gates.
    // Only non-retryable, transport-confirmed pre-execution refusals can be acknowledged.
    if (record.purpose !== undefined || record.projectId !== state.project.id || record.retryOf || record.retryRequestId
      || ![400, 401, 402, 403, 404, 413].includes(e.httpStatus) || rejectionReviewHash(record)) return blocked(kind, {
      whatHappened, unknown, whoActs: 'Operator', missing: 'This request is outside the non-retryable refusal acknowledgement path.',
      nextStep: 'Keep this held. An operator must reconcile the recorded refusal, project and linked retry; acknowledgement is unavailable.' });
    const acknowledgeHash = hash({ id: record.id, purpose: 'proposal_rejection', inputHash: record.inputHash,
      projectId: record.projectId, contextRevision: record.contextRevision, judge: record.judge,
      completedAt: record.completedAt, provider: p, case: kind });
    return { ...base, case: kind, action: 'acknowledge', acknowledgeHash, whatHappened, unknown,
      whoActs: 'You (the owner)', missing: null,
      nextStep: `Acknowledge this refused request. Its input, history and reservation stay saved. Nothing is retried. Resolve the provider or brief issue before a fresh request. ${after}` };
  }
  if (!task?.followThrough) return blocked(kind, { whatHappened, unknown, whoActs: 'Operator',
    missing: 'The coding task record for this review is missing.', nextStep: 'Keep this held. The operator must inspect the stored task history; Steward cannot confirm the task stopped.' });
  const entries = task.followThrough.reviews?.filter(r => r.id === record.id && r.headSha === record.headSha) ?? [];
  const review = entries.length === 1 ? entries[0] : null;
  // A crash after the transport records a refusal can leave this entry at intent.
  // Once the controller stops the task, the completed transport evidence permits
  // acknowledgement without rewriting or resuming that interrupted task history.
  if (task.id !== record.taskId || task.projectId !== state.project.id || record.projectId !== state.project.id
    || !review || !['intent', 'unknown'].includes(review.status)) return blocked(kind, { whatHappened, unknown, whoActs: 'Operator',
    missing: 'A matching project, coding task and unresolved review entry for this exact review and commit.',
    nextStep: 'Keep this held. The operator must inspect the stored task and review history before this refusal can be acknowledged.' });
  if (!taskStopped && (state.paused || state.coding?.paused || !state.pilot)) return blocked(kind, { whatHappened, unknown, whoActs: 'Operator',
    missing: 'Follow-through is paused or has no pilot; it cannot stop this task automatically.',
    nextStep: 'Keep this held. The operator must reconcile the interrupted task and restore a supported recovery path; waiting for a scheduled check will not resolve it.' });
  if (!taskStopped) return blocked(kind, { whatHappened, unknown, whoActs: 'Steward follow-through, then you',
    missing: 'The task follow-through has not stopped yet.', nextStep: 'Wait for the next follow-through check to stop this task, then refresh. Acknowledgement is offered only after the task has stopped.' });
  const acknowledgeHash = hash({ id: record.id, purpose: record.purpose, taskId: record.taskId, headSha: record.headSha, inputHash: record.inputHash,
    projectId: record.projectId, taskProjectId: task.projectId, review,
    contextRevision: record.contextRevision, judge: record.judge, completedAt: record.completedAt, provider: p, observation: record.rejectionObservation ?? null, case: kind, taskStatus: task.followThrough.status });
  return { ...base, case: kind, action: 'acknowledge', acknowledgeHash, whatHappened, unknown, whoActs: 'You (the owner)', missing: null,
    nextStep: `Acknowledge this failed review. That keeps its history and reservation, sends nothing and does not retry or resume the task. ${after}` };
}

/** Owner acknowledgement of a confirmed, provider-refused non-retryable request or coding review. It resolves only this
 * record's hold; it never retries, resumes a grant, refills allowance, or edits task history. */
export async function acknowledgeRejectedReview(store, input, now) {
  const { requestId, acknowledgeHash } = input ?? {};
  need(typeof requestId === 'string' && requestId.length <= 128 && typeof acknowledgeHash === 'string' && /^[a-f0-9]{64}$/.test(acknowledgeHash), 'INVALID_REQUEST');
  return store.change(state => {
    const record = own(state.requests, requestId);
    need(record, 'RECOVERY_REVIEW_STALE');
    if (record.status === 'rejection_acknowledged' && record.resolution?.acknowledgeHash === acknowledgeHash) return record;
    need(record.purpose === 'coding_review' || record.purpose === undefined, 'RECOVERY_NOT_SUPPORTED');
    const recovery = heldRecovery(state, record, now);
    need(recovery, 'RECOVERY_REVIEW_STALE');
    const refusedCases = ['confirmed_rejection', 'expired_authority', 'allowance_exhausted'];
    need(refusedCases.includes(recovery.case), 'RECOVERY_NOT_SUPPORTED');
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
