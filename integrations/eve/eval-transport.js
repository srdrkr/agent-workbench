import { endpoint, gatewayRequest } from './gateway-request.js';
import { mockModel } from 'eve/evals';
import { admitProvider, EVAL_MODEL, hash, openLedger } from './eval-ledger.js';
import { rejectionDiagnostics } from './rejection-diagnostics.js';

/** Construct a request-specific transport. Admission is durable across Eve replay. */
export function evalTransport({ ledgerPath, caseId, messageHash, sessionId, mock = false, send = fetch }) {
  return async (url, init) => {
    let body, serialized;
    try { ({ body, serialized } = gatewayRequest(url, init, EVAL_MODEL)); }
    catch { throw new Error('EVAL_REQUEST_DENIED'); }
    admitProvider(ledgerPath, { caseId, sessionId, messageHash, body: serialized, mode: mock ? 'mock' : 'live' });
    try {
      const response = mock ? await mockResponse(body) : await send(endpoint, { ...init, body: serialized, redirect: 'error' });
      const db = openLedger(ledgerPath);
      try { db.prepare('UPDATE cases SET http_status=? WHERE id=?').run(response.status, caseId); } finally { db.close(); }
      if (!response.ok) {
        const diagnostics = await rejectionDiagnostics(response);
        const rejected = openLedger(ledgerPath);
        try { rejected.prepare('UPDATE cases SET rejection=? WHERE id=?').run(JSON.stringify(diagnostics), caseId); }
        finally { rejected.close(); }
        // Raw bodies and headers never reach SDK errors or Eve persistence.
        // Retry-After is evidence only, never retry permission or a sleep plan.
        throw new Error('EVAL_PROVIDER_REJECTED');
      }
      return response;
    } catch { throw new Error('EVAL_PROVIDER_OUTCOME_UNKNOWN'); }
  };
}

export function locateCase(messages) {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const parts = typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text);
    for (const text of parts) {
      try {
        const value = JSON.parse(text);
        if (typeof value.evalCaseId === 'string') return { caseId: value.evalCaseId, messageHash: hash(text) };
      } catch { /* Other Eve context messages are not the approved request. */ }
    }
  }
  throw new Error('EVAL_REQUEST_NOT_APPROVED');
}

async function mockResponse(body) {
  if (body.tools[0].strict !== true) throw new Error('EVAL_STRICT_TOOL_REQUIRED');
  const model = mockModel(({ lastUserMessage }) => {
    const input = JSON.parse(lastUserMessage);
    const kind = input.evalCaseId === 'next-step' ? 'coding' : input.evalCaseId === 'commitment' ? 'commitment' : 'clarify';
    return { toolCalls: [{ name: 'final_output', input: { kind,
      candidateId: kind === 'coding' ? 'normalize' : null, title: 'Synthetic eval response',
      rationale: 'Deterministic protocol verification only; model judgment has not been evaluated.',
      citations: ['brief', 'acceptance'], question: kind === 'clarify' ? 'Which fact needs owner clarification?' : null,
    } }], usage: { inputTokens: 100, outputTokens: 50 } };
  });
  const result = await model.doStream(body);
  const encoder = new TextEncoder();
  return new Response(result.stream.pipeThrough(new TransformStream({
    transform(part, controller) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(part)}\n\n`)); },
  })), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
