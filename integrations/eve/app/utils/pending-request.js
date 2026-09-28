// Keep one uncertain submission across a page reload. This is a local receipt,
// never approval and never an instruction to send automatically.
export const PENDING_REQUEST_KEY = 'steward.pending-request.v1';

export function savePendingRequest(storage, request) {
  if (request) storage.setItem(PENDING_REQUEST_KEY, JSON.stringify(request));
  else storage.removeItem(PENDING_REQUEST_KEY);
}

export function loadPendingRequest(storage, projectId) {
  try {
    const r = JSON.parse(storage.getItem(PENDING_REQUEST_KEY) ?? 'null');
    if (!r || r.projectId !== projectId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.id)
      || typeof r.message !== 'string' || !r.message.trim() || r.message.length > 2000
      || !/^[a-f0-9]{64}$/.test(r.expectedContextRevision) || !Number.isFinite(Date.parse(r.createdAt))) return null;
    return { id: r.id, projectId: r.projectId, expectedContextRevision: r.expectedContextRevision,
      message: r.message, createdAt: r.createdAt, unknown: true, reconciled: false };
  } catch { return null; }
}
