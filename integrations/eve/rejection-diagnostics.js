// Only these machine categories may leave the transient response parser.
// Gateway SDK error types plus documented budget and Anthropic error types.
const categories = new Set(['authentication_error', 'invalid_request_error', 'rate_limit_exceeded',
  'model_not_found', 'not_found', 'internal_server_error', 'failed_dependency', 'forbidden',
  'quota_for_entity_exceeded', 'permission_error', 'not_found_error', 'request_too_large',
  'rate_limit_error', 'api_error', 'overloaded_error']);

export function parseRetryAfter(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  if (/^\d{1,6}$/.test(value) && Number(value) <= 604800) return { kind: 'seconds', seconds: Number(value) };
  // Accept canonical IMF-fixdate only. Date.parse alone accepts loose prose.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toUTCString() === value ? { kind: 'date', at: date.toISOString() } : null;
}

function requestIdentifier(headers, body) {
  const requestId = value => typeof value === 'string' && /^(?:req_[A-Za-z0-9]{8,80}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value);
  for (const header of ['request-id', 'x-request-id']) {
    const value = headers.get(header);
    if (requestId(value)) return { source: header, value };
  }
  if (requestId(body?.request_id)) return { source: 'request_id', value: body.request_id };
  if (typeof body?.generationId === 'string' && /^gen_[A-Za-z0-9]{8,80}$/.test(body.generationId)) {
    return { source: 'generationId', value: body.generationId };
  }
  const nested = body?.providerMetadata?.gateway?.generationId;
  if (typeof nested === 'string' && /^gen_[A-Za-z0-9]{8,80}$/.test(nested)) return { source: 'providerMetadata.gateway.generationId', value: nested };
  return null;
}

function providerDiagnostics(body) {
  const result = {};
  if (body?.error?.details?.error_code === 'enforced_spend_limit_reached') result.providerErrorCode = 'enforced_spend_limit_reached';
  const gateway = body?.providerMetadata?.gateway;
  if (typeof gateway?.generationId === 'string' && /^gen_[A-Za-z0-9]{8,80}$/.test(gateway.generationId)) result.gatewayGenerationId = gateway.generationId;
  const models = gateway?.routing?.modelAttempts;
  if (!Array.isArray(models) || models.length > 3) return result;
  const attempts = models.flatMap(model => Array.isArray(model?.providerAttempts) && model.providerAttempts.length <= 3 ? model.providerAttempts : []);
  const errors = attempts.filter(a => a?.provider === 'anthropic' && a.success === false && Number.isInteger(a.statusCode) && a.statusCode >= 400 && a.statusCode <= 599)
    .map(a => ({ provider: 'anthropic', statusCode: a.statusCode,
      ...(a.error === 'Service temporarily unavailable' ? { category: 'service_unavailable' } : {}) }));
  if (errors.length) result.providerErrors = errors;
  return result;
}

/** Consume, never clone, a rejection body. Bound bytes and time, discard on any
 * parsing failure. Retain only selected typed fields from nested routing errors,
 * never arbitrary provider prose, credentials, or request/response payloads. */
export async function rejectionDiagnostics(response) {
  let body;
  let timer;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      body = await Promise.race([
        (async () => {
          const chunks = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16384) return undefined;
            chunks.push(value);
          }
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        })(),
        new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 500); }),
      ]);
    } catch { /* Missing evidence stays missing. */ }
    finally {
      clearTimeout(timer);
      // A hung cancellation must not extend the diagnostic deadline.
      void reader.cancel().catch(() => {});
    }
  }
  const category = [body?.error?.type, body?.error?.code].find(value => categories.has(value)) ?? null;
  return { httpStatus: response.status, errorCategory: category,
    requestIdentifier: requestIdentifier(response.headers, body), retryAfter: parseRetryAfter(response.headers.get('retry-after')),
    ...providerDiagnostics(body) };
}
