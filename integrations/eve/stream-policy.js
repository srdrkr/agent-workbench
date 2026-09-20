/** Recover only the existing read-only stream; this never retries a create POST. */
export function judgmentObservation(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error('JUDGE_CONFIG_INVALID');
  return {
    signal: AbortSignal.timeout(timeoutMs),
    streamReconnectPolicy: {
      streamOpenReconnectPolicy: { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 500 },
      streamIdleReconnectPolicy: { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 1000 },
      retryableErrorStatuses: [408, 429, 500, 502, 503, 504],
    },
  };
}
