import { requireOwner } from './auth.js';
const reply = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const allowedErrors = new Set(['PILOT_SETTINGS_INVALID', 'PILOT_REVIEW_STALE', 'MEMORY_LIMIT', 'PROGRESS_TOO_LARGE', 'CONTINUATION_CONTEXT_CHANGED', 'CONTINUATION_UNAVAILABLE', 'CONTINUATION_REVIEW_STALE', 'CONTINUATION_SOURCE_EXPIRED', 'RETRY_REVIEW_MISMATCH', 'RECOVERY_REVIEW_STALE', 'RECOVERY_NOT_SUPPORTED', 'RECOVERY_TASK_ACTIVE', 'RETRY_NOT_READY', 'INVALID_REQUEST', 'REQUEST_ID_CONFLICT', 'ADMISSION_PAUSED', 'UNRESOLVED_MODEL_ATTEMPT', 'CONTEXT_EXPIRED', 'CONTEXT_NOT_APPROVED', 'CONTEXT_TOO_LARGE', 'APPROVAL_MISMATCH', 'APPROVAL_UNAVAILABLE', 'CODING_NOT_ENABLED', 'INVALID_CONTEXT', 'CONTEXT_WORK_UNRESOLVED', 'CONTEXT_PREVIEW_STALE', 'CONTEXT_CHANGE_LIMIT', 'CODING_APPROVAL_MISMATCH', 'CODING_ADMISSION_PAUSED', 'CODING_SCOPE_NOT_CONFIGURED', 'CODING_TASK_ALREADY_ATTEMPTED', 'CODING_PREFLIGHT_FAILED', 'CODING_EVIDENCE_UNAVAILABLE', 'CODING_OBSERVATION_INVALID', 'CODING_RELEASE_UNVERIFIED', 'CODING_TASK_UNKNOWN']);
export function hostedHandler({ auth, steward, ownerEmail, origin }) {
  return async request => {
    const path = new URL(request.url).pathname;
    // Only the three login endpoints are publicly reachable. Owner creation is
    // a separate operator command, never a request-triggered bootstrap.
    if (path.startsWith('/api/auth/')) {
      const expected = { '/api/auth/sign-in/email': 'POST', '/api/auth/sign-out': 'POST', '/api/auth/get-session': 'GET' }[path];
      if (!expected || expected !== request.method) return reply({ error: 'NOT_FOUND' }, 404);
      if (request.method === 'POST' && request.headers.get('origin') !== origin) return reply({ error: 'ORIGIN_DENIED' }, 403);
      return auth.handler(request);
    }
    try {
      await requireOwner(auth, request, ownerEmail, origin);
      if (path === '/api/steward/state' && request.method === 'GET') return reply(await steward.view());
      if (request.method !== 'POST') return reply({ error: 'NOT_FOUND' }, 404);
      const bodyLimit = path === '/api/steward/context/preview' ? 20000 : 8192;
      const declared = Number(request.headers.get('content-length'));
      if (declared > bodyLimit || !request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'INVALID_REQUEST' }, 400);
      // Bound the stream before buffering, including chunked requests.
      const reader = request.body?.getReader();
      if (!reader) return reply({ error: 'INVALID_REQUEST' }, 400);
      const chunks = []; let size = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > bodyLimit) { await reader.cancel(); return reply({ error: 'INVALID_REQUEST' }, 413); } chunks.push(Buffer.from(value)); }
      let input; try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply({ error: 'INVALID_REQUEST' }, 400); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return reply({ error: 'INVALID_REQUEST' }, 400);
      const pilotActions = { '/api/steward/pilot/review': 'reviewPilot', '/api/steward/pilot/approve': 'approvePilot', '/api/steward/memory/note': 'saveNote', '/api/steward/commitment/complete': 'completeCommitment', '/api/steward/resume': 'resume' };
      if (Object.hasOwn(pilotActions, path)) return reply(await steward[pilotActions[path]](input));
      if (path === '/api/steward/continuation/review') return reply(await steward.reviewContinuation());
      if (path === '/api/steward/continuation/approve') return reply(await steward.approveContinuation(input));
      if (path === '/api/steward/context/preview') return reply(await steward.previewContext(input.project));
      if (path === '/api/steward/context/apply') return reply(await steward.applyContext(input));
      const codingActions = { '/api/steward/coding/prepare': 'prepare', '/api/steward/coding/close': 'close',  '/api/steward/coding/review': 'review', '/api/steward/coding/approve': 'approveAndDispatch', '/api/steward/coding/reconcile': 'reconcile', '/api/steward/coding/observe': 'observe', '/api/steward/coding/release': 'release' };
      if (Object.hasOwn(codingActions, path)) {
        if (!steward.coding) throw new Error('CODING_NOT_ENABLED');
        return reply(await steward.coding[codingActions[path]](input));
      }
      if (path === '/api/steward/recovery/acknowledge') return reply(await steward.acknowledgeRejectedReview(input));
      if (path === '/api/steward/propose') return reply(await steward.propose(input));
      if (path === '/api/steward/approve') return reply(await steward.approve(input));
      if (path === '/api/steward/pause') return reply(await steward.pause());
      return reply({ error: 'NOT_FOUND' }, 404);
    } catch (error) {
      if (error.message === 'UNAUTHORIZED') return reply({ error: 'UNAUTHORIZED' }, 401);
      if (error.message === 'ORIGIN_DENIED') return reply({ error: 'ORIGIN_DENIED' }, 403);
      return reply({ error: allowedErrors.has(error.message) ? error.message : 'STEWARD_UNAVAILABLE' }, 409);
    }
  };
}
