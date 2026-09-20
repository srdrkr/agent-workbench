// An explicitly scripted interaction fixture. This is not a language model or an eval of one.
export async function demoJudge({ request, project }) {
  const citations = project.sources.map(s => s.id);
  if (/remember|commitment|follow.up|friday|keep.+visible/i.test(request)) return {
    kind: 'commitment', candidateId: null, title: request.slice(0, 240), citations,
    rationale: 'Keep this owner-requested follow-through visible alongside the project priority. It will remain proposed until accepted.', question: null,
  };
  if (/block|conflict|summari/i.test(request)) return {
    kind: 'clarify', candidateId: null, title: 'Resolve the known defect before widening scope', citations,
    rationale: 'The brief prioritizes normalization and the acceptance source supplies an existing test. No additional dependency is established by this context.',
    question: 'Is there a new blocker or decision that the project brief should include?',
  };
  return { kind: 'coding', candidateId: project.codingCandidates[0].id,
    title: project.codingCandidates[0].title, citations, question: null,
    rationale: 'The project brief prioritizes predictable links. The existing normalization test makes this a bounded next step with observable completion evidence.' };
}

export const demoFire = lost => async () => {
  if (lost) throw new Error('Synthetic response lost');
  return new Response(JSON.stringify({ type: 'routine_fire', claude_code_session_id: 'session_SYNTHETIC',
    claude_code_session_url: 'https://claude.ai/code/session_SYNTHETIC' }));
};

export function demoReader(task) {
  const sha = '2'.repeat(40);
  const pr = { number: 1, state: 'open', draft: true, merged_at: null, body: task.marker,
    head: { sha, ref: task.branch, repo: { full_name: task.spec.repository } },
    base: { sha: task.spec.baseSha, ref: task.spec.baseBranch, repo: { full_name: task.spec.repository } } };
  return async path => {
    if (path.includes('/files')) return task.spec.allowedPaths.map(filename => ({ filename }));
    if (path.includes('/check-runs')) return { check_runs: task.spec.requiredChecks.map((c, i) => ({
      id: i + 1, name: c.name, app: { id: c.appId }, head_sha: sha, status: 'completed', conclusion: 'success',
    })) };
    if (path.includes('/compare/')) return { status: 'ahead', base_commit: { sha: task.spec.baseSha }, merge_base_commit: { sha: task.spec.baseSha } };
    if (path.includes('/pulls?')) return [pr];
    if (path.includes('/pulls/')) return pr;
    throw new Error('Unexpected synthetic evidence request');
  };
}
