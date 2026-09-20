import { Client } from 'eve/client';
import { proposalSchema } from './schema.js';
import { judgmentObservation } from './stream-policy.js';

/** Server-side adapter. Its caller owns disclosure approval and proposal authority. */
export async function createEveJudge(config = {}) {
  if (config.enabled !== true) return async () => { throw new Error('JUDGE_DISABLED'); };
  let host;
  try { host = new URL(config.host); } catch { throw new Error('JUDGE_CONFIG_INVALID'); }
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(host.hostname);
  if ((!local && host.protocol !== 'https:') || !['https:', 'http:'].includes(host.protocol)
      || host.username || host.password || host.search || host.hash
      || typeof config.authToken !== 'string' || config.authToken.length < 24
      || /\s/.test(config.authToken)) throw new Error('JUDGE_CONFIG_INVALID');
  const timeoutMs = config.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error('JUDGE_CONFIG_INVALID');
  }
  const client = new Client({ host: host.href, auth: { bearer: config.authToken }, redirect: 'error' });
  return async ({ request, project, commitments, hostedRequestId }) => {
    // Disclosure is all-or-nothing: silently dropping sources would mislabel the
    // project revision. Old commitments need a fresh owner-approved export.
    if (typeof project?.revision !== 'string' || !project.revision
        || !Array.isArray(project.sources) || !project.sources.length
        || project.sources.some(source => source.exposure !== 'model_allowed')
        || !Array.isArray(commitments)
        || commitments.some(commitment => commitment.contextRevision !== project.revision)) {
      throw new Error('JUDGE_CONTEXT_NOT_APPROVED_FOR_MODEL');
    }
    let message;
    try {
      if (config.hosted && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(hostedRequestId ?? '')) throw new Error();
      message = JSON.stringify({ request, project, commitments, ...(config.hosted ? { hostedRequestId } : {}) });
      if (typeof request !== 'string' || !request.trim() || !project || !Array.isArray(commitments)
          || Buffer.byteLength(message) > 32_768) throw new Error();
    } catch { throw new Error('JUDGE_INPUT_INVALID'); }
    try {
      // Exactly one create attempt. An HTTP timeout does not prove server cancellation.
      const { response } = await client.sessions.create({
        message,
        outputSchema: proposalSchema,
        ...judgmentObservation(timeoutMs),
      });
      const result = await response.result();
      // Eve parks conversational sessions after a completed turn. Its aggregate
      // status is then "waiting" even though the structured result is final.
      if (!['completed', 'waiting'].includes(result.status)
          || !result.events.some(event => event.type === 'turn.completed')
          || !result.events.some(event => event.type === 'result.completed')
          || result.events.some(event => ['step.failed', 'turn.failed', 'session.failed'].includes(event.type))) throw new Error();
      const parsed = proposalSchema.safeParse(result.data);
      if (!parsed.success) throw new Error();
      return parsed.data;
    } catch {
      // Provider errors and stream events may contain submitted context or credentials.
      throw new Error('JUDGE_UNAVAILABLE_OR_INVALID');
    }
  };
}
