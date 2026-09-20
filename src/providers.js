// Only transport code sees credentials. No provider body/error text is logged.
export const API_VERSION = '2023-06-01';
export const ROUTINES_BETA = 'experimental-cc-routine-2026-04-01';
export const GITHUB_VERSION = '2022-11-28';

export function sessionReference(body) {
  const id = body?.claude_code_session_id;
  if (body?.type !== 'routine_fire' || typeof id !== 'string' || !/^session_[A-Za-z0-9_-]+$/.test(id)) return null;
  const url = `https://claude.ai/code/${id}`;
  return body.claude_code_session_url === url ? { id, url } : null;
}

// Only fixed labels, JSON kinds and booleans leave this diagnostic boundary.
// Even unknown property names, headers and error messages may contain secrets.
function responseDiagnostics(body, status) {
  const kind = value => value === undefined ? 'absent' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const id = body?.claude_code_session_id;
  const validId = typeof id === 'string' && /^session_[A-Za-z0-9_-]+$/.test(id);
  let reason = 'unexpected_http_response';
  if (status === 200) {
    reason = kind(body) !== 'object' ? 'unexpected_body_kind' :
      body.type !== 'routine_fire' ? 'unexpected_response_type' :
      !validId ? 'invalid_session_id' : 'session_url_mismatch';
  }
  return { reason, bodyKind: kind(body), fields: {
    type: kind(body?.type), sessionId: kind(id), sessionUrl: kind(body?.claude_code_session_url),
    error: kind(body?.error), errorType: kind(body?.error?.type),
  }, typeIsRoutineFire: body?.type === 'routine_fire', sessionIdValid: validId,
  sessionUrlMatchesId: validId && body?.claude_code_session_url === `https://claude.ai/code/${id}` };
}

export async function fireRoutine({ routineId, text, token, fetchImpl = fetch }) {
  if (!/^trig_[A-Za-z0-9_-]+$/.test(routineId) || !token || text.length > 65536) {
    throw new Error('Invalid dispatch configuration');
  }
  const started = Date.now();
  let status;
  try {
    const response = await fetchImpl(`https://api.anthropic.com/v1/claude_code/routines/${routineId}/fire`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'anthropic-version': API_VERSION,
        'anthropic-beta': ROUTINES_BETA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    status = response.status;
    const raw = await response.text();
    if (raw.length > 65536) return { outcome: 'unknown', status, diagnostics: { reason: 'response_too_large' }, latencyMs: Date.now() - started };
    let body;
    try { body = JSON.parse(raw); } catch {
      return { outcome: 'unknown', status, diagnostics: { reason: 'invalid_json' }, latencyMs: Date.now() - started };
    }
    const session = status === 200 && sessionReference(body);
    if (session) return { outcome: 'accepted', session, status, latencyMs: Date.now() - started };
    const errors = { 400: 'invalid_request_error', 401: 'authentication_error',
      403: 'permission_error', 404: 'not_found_error', 429: 'rate_limit_error' };
    if (body?.type === 'error' && errors[status] && body.error?.type === errors[status]) {
      const retry = response.headers.get('retry-after');
      return { outcome: status === 429 ? 'usage_limited' : 'rejected', status,
        retryAfterSeconds: /^\d{1,8}$/.test(retry) ? Number(retry) : null,
        latencyMs: Date.now() - started };
    }
    return { outcome: 'unknown', status, ...(status === 200 && typeof body?.claude_code_session_url === 'string' && /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]{1,100}$/.test(body.claude_code_session_url) ? { sessionUrlHint: body.claude_code_session_url } : {}), diagnostics: responseDiagnostics(body, status), latencyMs: Date.now() - started };
  } catch {
    // Timeout, connection loss, redirects and 5xx cannot prove that no session started.
    return { outcome: 'unknown', ...(status === undefined ? {} : { status }),
      diagnostics: { reason: 'request_or_body_read_failed' }, latencyMs: Date.now() - started };
  }
}

export function githubReader(token, fetchImpl = fetch) {
  return async (path, { allow404 = false } = {}) => {
    if (!path.startsWith('/repos/') || /(?:^|\/)\.\.?(?:\/|$)/.test(path)) throw new Error('Invalid evidence path');
    try {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': GITHUB_VERSION },
      });
      if (response.status === 404 && allow404) return null;
      if (!response.ok) throw new Error();
      const raw = await response.text();
      if (raw.length > 2_000_000) throw new Error();
      return JSON.parse(raw);
    } catch { throw new Error('GitHub evidence unavailable; prior observations preserved'); }
  };
}

export async function repositoryPreflight(spec, read) {
  const repo = await read(`/repos/${spec.repository}`);
  const base = await read(`/repos/${spec.repository}/commits/${spec.baseBranch}`);
  if (!['public', 'private'].includes(spec.visibility) || repo.private !== (spec.visibility === 'private') ||
      repo.full_name !== spec.repository || repo.default_branch !== spec.baseBranch || base.sha !== spec.baseSha) {
    throw new Error('Approved repository visibility or default-branch revision no longer matches');
  }
}

// All pagination uses locally constructed paths, never provider-supplied URLs.
async function pages(read, path, field) {
  const result = [];
  for (let page = 1; page <= 10; page++) {
    const body = await read(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = field ? body[field] : body;
    if (!Array.isArray(rows)) throw new Error('Invalid GitHub evidence');
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new Error('Evidence pagination limit reached; manual review required');
}

export async function collectEvidence(task, read) {
  const spec = task.spec;
  const root = `/repos/${spec.repository}`;
  const owner = spec.repository.split('/')[0];
  const prs = await pages(read, `${root}/pulls?state=all&head=${encodeURIComponent(`${owner}:${task.branch}`)}`);
  const matching = prs.filter(pr => pr.head?.repo?.full_name === spec.repository &&
    pr.head.ref === task.branch && pr.base?.repo?.full_name === spec.repository &&
    pr.base.ref === spec.baseBranch && pr.body?.includes(task.marker));
  if (matching.length !== 1) {
    const branch = await read(`${root}/branches/${encodeURIComponent(task.branch)}`, { allow404: true });
    if (branch !== null && !/^[a-f0-9]{40}$/.test(branch?.commit?.sha)) throw new Error('Invalid branch evidence');
    return { source: 'github_api', result: matching.length ? 'conflicting_prs' : branch ? 'branch_without_pr' : 'not_found',
      branch: branch ? { name: task.branch, headSha: branch.commit.sha,
        commitUrl: `https://github.com/${spec.repository}/commit/${branch.commit.sha}`,
        compareUrl: `https://github.com/${spec.repository}/compare/${spec.baseSha}...${branch.commit.sha}`,
        verification: 'partial_effect_only' } : null };
  }
  const pr = matching[0];
  if (!Number.isSafeInteger(pr.number) || pr.number < 1 || !/^[a-f0-9]{40}$/.test(pr.head.sha)) {
    throw new Error('Invalid GitHub result identity');
  }
  const sha = pr.head.sha;
  const comparison = await read(`${root}/compare/${spec.baseSha}...${sha}?per_page=1`);
  const approvedBase = pr.base.sha === spec.baseSha && comparison.base_commit?.sha === spec.baseSha &&
    comparison.merge_base_commit?.sha === spec.baseSha && ['ahead', 'identical'].includes(comparison.status);
  const files = await pages(read, `${root}/pulls/${pr.number}/files`);
  const checks = await pages(read, `${root}/commits/${sha}/check-runs?filter=latest`, 'check_runs');
  const scopeMatches = files.length > 0 && files.every(f => spec.allowedPaths.includes(f.filename) &&
    (!f.previous_filename || spec.allowedPaths.includes(f.previous_filename)));
  const required = spec.requiredChecks.map(requirement => {
    const matches = checks.filter(c => c.name === requirement.name && c.app?.id === requirement.appId && c.head_sha === sha);
    const latest = matches.sort((a, b) => b.id - a.id)[0];
    return { name: requirement.name, appId: requirement.appId, id: latest?.id ?? null,
      status: latest?.status ?? 'missing', conclusion: latest?.conclusion ?? null };
  });
  // A head change during the reads invalidates the snapshot instead of blessing stale CI.
  const current = await read(`${root}/pulls/${pr.number}`);
  const sameIdentity = current.head?.sha === sha && current.head?.ref === task.branch &&
    current.head?.repo?.full_name === spec.repository && current.base?.ref === spec.baseBranch &&
    current.base?.repo?.full_name === spec.repository && current.body?.includes(task.marker) &&
    (current.number === undefined || current.number === pr.number);
  const merged = sameIdentity && current.state === 'closed' && current.merged === true
    && Number.isFinite(Date.parse(current.merged_at)) && /^[a-f0-9]{40}$/.test(current.merge_commit_sha);
  const stable = sameIdentity && current.base?.sha === spec.baseSha &&
    current.state === 'open' && current.draft === true && !current.merged_at;
  const tested = required.every(c => c.status === 'completed' && c.conclusion === 'success');
  return { source: 'github_api', result: merged ? 'merged_pr' : stable && approvedBase && scopeMatches && tested ? 'tested_draft_pr' : 'needs_review',
    prNumber: pr.number, prUrl: `https://github.com/${spec.repository}/pull/${pr.number}`,
    headSha: sha, commitUrl: `https://github.com/${spec.repository}/commit/${sha}`,
    ...(merged ? { mergedAt: current.merged_at, mergeCommitSha: current.merge_commit_sha } : {}),
    scopeMatches, stable, approvedBase, baseSha: spec.baseSha, requiredChecks: required,
    workerReport: { source: 'worker_self_report', present: Boolean(pr.body), verified: false } };
}
