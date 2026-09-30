/** Read only the existing durable stream. No create/send/resume or model call. */
export function createSessionObserver({ enabled, host, authToken, timeoutMs = 15_000 } = {}) {
  if (!enabled) return null;
  let origin;
  try { origin = new URL(host); } catch { throw new Error('JUDGE_CONFIG_INVALID'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname);
  if ((!local && origin.protocol !== 'https:') || !['https:', 'http:'].includes(origin.protocol)
    || origin.username || origin.password || origin.search || origin.hash
    || typeof authToken !== 'string' || authToken.length < 24 || /\s/.test(authToken)
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) throw new Error('JUDGE_CONFIG_INVALID');
  return async ({ sessionId, requestId }) => {
    if (!/^wrun_[A-Za-z0-9_]{8,100}$/.test(sessionId ?? '')
      || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(requestId ?? '')) throw new Error('RECOVERY_NOT_SUPPORTED');
    const url = new URL(`eve/v1/session/${sessionId}/stream`, origin.href.endsWith('/') ? origin : `${origin.href}/`);
    url.searchParams.set('includeTailIndex', '1');
    const signal = AbortSignal.timeout(timeoutMs);
    let reader;
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal,
        headers: { authorization: `Bearer ${authToken}` } });
      const tail = response.headers.get('x-eve-stream-tail-index');
      // This deliberately recognizes only the single-turn, one-step-limit failure.
      // A truncated prefix, extra turn, result, or unsupported event stays held.
      reader = response.body?.getReader();
      if (!response.ok || tail !== '7' || !reader) throw new Error();
      const decoder = new TextDecoder(); const events = []; let pending = ''; let bytes = 0;
      while (events.length < 8) {
        const { done, value } = await reader.read();
        if (done) throw new Error();
        bytes += value.length; if (bytes > 131_072) throw new Error();
        pending += decoder.decode(value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n')) >= 0 && events.length < 8) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          // Eve 0.47.3 emits a leading blank framing line, outside event indexes.
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          const d = event.data;
          // Retain only non-content fields. Even error messages are allowlisted.
          events.push({ type: event.type, at: event.meta?.at, code: d?.code,
            limit: d?.message === 'JUDGE_STEP_LIMIT', sequence: d?.sequence, turnId: d?.turnId,
            stepIndex: d?.stepIndex, sessionId: d?.sessionId, agentId: d?.runtime?.agentId,
            requestMatches: event.type === 'message.received' && JSON.parse(d?.message ?? 'null')?.hostedRequestId === requestId });
        }
      }
      signal.throwIfAborted();
      if (events.map(e => e.type).join(',') !== 'session.started,turn.started,message.received,step.started,step.completed,step.failed,turn.failed,session.failed'
        || events[0].agentId !== 'workbench-eve-judge' || !events[2].requestMatches
        || events.slice(1, 7).some(e => e.sequence !== 0 || e.turnId !== 'turn_0')
        || events[3].stepIndex !== 0 || events[4].stepIndex !== 0 || events[5].stepIndex !== 1
        || events.slice(5).some(e => e.code !== 'MODEL_SELECTION_FAILED' || !e.limit)
        || events[7].sessionId !== sessionId
        || events.some(e => !Number.isFinite(Date.parse(e.at)))
        || events.some((e, i) => i > 0 && Date.parse(e.at) < Date.parse(events[i - 1].at))) throw new Error();
      return { source: 'eve_session_stream', sessionId, terminalAt: events[7].at,
        code: 'MODEL_SELECTION_FAILED', reason: 'JUDGE_STEP_LIMIT', eventCount: 8 };
    } catch { throw new Error('RECOVERY_EVIDENCE_UNAVAILABLE'); }
    finally { await reader?.cancel().catch(() => {}); }
  };
}
