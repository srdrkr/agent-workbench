// Synthetic held coding-review construction for tests and the local browser verifier.
// Only the coding task itself is seeded (as in follow-through.test.js); the review
// request, reservation, provider outcome and task stop come from the real
// FollowThrough, createCodeReview and hostedTransport code paths with a fake send.
import { FollowThrough, followThroughGrant } from '../hosted/follow-through.js';
import { createCodeReview } from '../hosted/code-review.js';
import { hostedTransport, HOSTED_MODEL } from '../hosted/transport.js';
import { digest } from '../hosted/steward.js';

export const SYNTHETIC_HEAD = 'a'.repeat(40);
const endpoint = 'https://ai-gateway.vercel.sh/v4/ai/language-model';
const json = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// Each outcome is what the fake provider does with the one admitted review request.
export const reviewOutcomes = {
  refused: json(400, { error: { type: 'invalid_request_error', message: 'synthetic schema refusal' } }),
  rate_limited: json(429, { error: { type: 'rate_limit_exceeded', message: 'synthetic' } }),
  spend_limit: json(429, { error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }),
  status_only: () => new Response('synthetic non-JSON body', { status: 400 }),
  server_error: json(500, { error: { type: 'internal_server_error' } }),
  lost: () => { throw new Error('synthetic lost response'); },
  unverified: () => new Response('synthetic unparseable output', { status: 200 }),
};

export function syntheticReader(task, head = SYNTHETIC_HEAD) {
  return async path => path.includes('/files?') ? [{ filename: 'slug.js', patch: '@@ -1 +1 @@\n-a\n+b' }]
    : { state: 'open', head: { sha: head, ref: task.branch, repo: { full_name: task.spec.repository } },
      base: { sha: task.spec.baseSha, ref: 'main', repo: { full_name: task.spec.repository } }, body: task.marker };
}

/** Seeds one closed, observed synthetic coding task with an active follow-through grant. */
export async function seedSyntheticTask(store, now, id = 'synthetic-task') {
  return store.change(state => {
    const at = now();
    const task = { id, projectId: state.project.id, contextRevision: state.project.revision, scopeHash: 'synthetic-scope',
      branch: 'claude/synthetic-task', marker: '<!-- synthetic-task -->', dispatchStartedAt: at, releasedAt: at,
      spec: { taskId: id, repository: 'example/synthetic', visibility: 'public', baseBranch: 'main', baseSha: '0'.repeat(40), requiredChecks: [],
        allowedPaths: ['slug.js'], objective: 'Synthetic: normalize slugs', acceptance: 'Synthetic: collapse whitespace' },
      dispatch: 'accepted', execution: 'exited', executionObservation: { markerVerified: true, recordedEvent: 1, observedAt: at },
      result: { source: 'github_api', result: 'tested_draft_pr', headSha: SYNTHETIC_HEAD, prNumber: 5, prUrl: 'https://github.com/example/synthetic/pull/5',
        scopeMatches: true, approvedBase: true, collectionStartedEvent: 2, observedAt: at, requiredChecks: [] } };
    task.followThrough = { grant: followThroughGrant(task, at), status: 'waiting_for_pr', activeJobId: id, reviews: [], attempts: [], nextCheckAt: at };
    state.coding ??= { jobs: {}, active: null, paused: false };
    state.coding.jobs[id] = task;
    return structuredClone(task);
  });
}

/** Runs one real follow-through review against the fake provider outcome. */
export async function runSyntheticReview({ store, now, outcome, counters = { judge: 0, send: 0 }, taskId = 'synthetic-task' }) {
  const task = (await store.read()).coding.jobs[taskId];
  const judge = async input => {
    counters.judge++;
    const transport = hostedTransport({ store, requestId: input.hostedRequestId, inputDigest: digest(input), sessionId: 'synthetic-review-session', now,
      send: async () => { counters.send++; return reviewOutcomes[outcome](); } });
    try {
      await transport(endpoint, { method: 'POST', headers: { 'ai-language-model-id': HOSTED_MODEL }, body: JSON.stringify({ maxOutputTokens: 2048,
        prompt: [{ role: 'user', content: JSON.stringify(input) }], tools: [{ type: 'function', name: 'final_output', inputSchema: { type: 'object' } }] }) });
    } catch { return null; }
    return null; // A 2xx body that never became a validated result.
  };
  const controller = new FollowThrough({ store, now, coding: { reconcile: async ({ requestId }) => structuredClone((await store.read()).coding.jobs[requestId]) },
    review: createCodeReview({ store, now, read: syntheticReader(task), judge }) });
  await controller.run();
  const state = await store.read();
  return { counters, reviewId: state.coding.jobs[taskId].followThrough.reviews.at(-1)?.id, state };
}
