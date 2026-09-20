/** Limit each resolved model instance to one provider call and sanitize failures. */
export function boundedModel(model, { timeoutMs = 30_000, maxOutputTokens = 2048 } = {}) {
  let called = false;
  const invoke = async (method, params) => {
    if (called) throw new Error('JUDGE_MODEL_RETRY_BLOCKED');
    called = true;
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      const result = await model[method]({
        ...params,
        maxOutputTokens,
        abortSignal: params.abortSignal ? AbortSignal.any([params.abortSignal, deadline]) : deadline,
      });
      if (method === 'doStream') {
        // Never pass raw provider error chunks to Eve's persisted event log.
        const reader = result.stream.getReader();
        result.stream = new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) controller.close();
              else if (value.type === 'error') controller.error(new Error('JUDGE_MODEL_FAILED'));
              else controller.enqueue(value);
            } catch { controller.error(new Error('JUDGE_MODEL_FAILED')); }
          },
          async cancel() { try { await reader.cancel(); } catch { /* private provider error */ } },
        });
      }
      return result;
    } catch { throw new Error('JUDGE_MODEL_FAILED'); }
  };
  return new Proxy(model, {
    get(target, property) {
      if (property === 'doStream' || property === 'doGenerate') return params => invoke(property, params);
      return Reflect.get(target, property, target);
    },
  });
}
