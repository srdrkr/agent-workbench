import { createHash } from 'node:crypto';
import { endpoint, gatewayRequest } from '../gateway-request.js';
import { rejectionDiagnostics } from '../rejection-diagnostics.js';
import { databasePool, HostedStore } from './store.js';
const hash = value => createHash('sha256').update(value).digest('hex');
export const HOSTED_MODEL = 'anthropic/claude-opus-5';
let pool;
export function hostedTransportFromEnv(messages, sessionId) {
  if (process.env.WORKBENCH_EVE_GATEWAY_APPROVED !== 'yes' || !process.env.AI_GATEWAY_API_KEY) throw new Error('HOSTED_NOT_AUTHORIZED');
  pool ??= databasePool(process.env.DATABASE_URL);
  const store = new HostedStore(pool, { ownerId: process.env.WORKBENCH_OWNER_EMAIL?.toLowerCase(), projectId: process.env.WORKBENCH_PROJECT_ID });
  const inputs = messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(p => p.type === 'text').map(p => p.text));
  const matches = inputs.flatMap(text => { try { const value = JSON.parse(text); return typeof value.hostedRequestId === 'string' ? [{ requestId: value.hostedRequestId, inputDigest: hash(text) }] : []; } catch { return []; } });
  if (matches.length !== 1) throw new Error('HOSTED_REQUEST_NOT_APPROVED');
  return hostedTransport({ store, ...matches[0], sessionId });
}
export function hostedTransport({ store, requestId, inputDigest, sessionId, send = fetch, now = () => new Date().toISOString() }) {
  return async (url, init) => {
    const { serialized } = gatewayRequest(url, init, HOSTED_MODEL);
    const bytes = Buffer.byteLength(serialized);
    // Conservative reservation, never refunded automatically after uncertain I/O.
    const reserve = (bytes + 2048) * 10 + 2048 * 25;
    await store.change(state => {
      const record = Object.hasOwn(state.requests, requestId) && state.requests[requestId];
      if (!state.project.sources.every(s => Date.parse(s.observedAt) <= Date.parse(now()) && Date.parse(s.expiresAt) > Date.parse(now()))
        || Object.values(state.requests).filter(r => r.provider).length >= 5
        || state.paused || state.model !== HOSTED_MODEL || !record || record.status !== 'thinking'
        || record.contextRevision !== state.project.revision || record.projectId !== state.project.id
        || record.inputDigest !== inputDigest || record.provider || !sessionId || bytes > 12000
        || state.reservedMicros + reserve > state.budgetMicros) throw new Error('HOSTED_PROVIDER_ADMISSION_DENIED');
      state.reservedMicros += reserve;
      record.provider = { sessionId, reservedMicros: reserve, requestBytes: bytes, requestHash: hash(serialized), intentAt: now() };
    });
    try {
      const response = await send(endpoint, { ...init, body: serialized, redirect: 'error' });
      const rejection = response.ok ? undefined : await rejectionDiagnostics(response);
      await store.change(state => { const provider = state.requests[requestId].provider; provider.httpStatus = response.status; if (rejection) provider.rejection = rejection; });
      if (!response.ok) throw new Error();
      return response;
    } catch { throw new Error('HOSTED_PROVIDER_OUTCOME_UNKNOWN'); }
  };
}
