const fail = message => { throw new Error(message); };
const string = (value, pattern) => typeof value === 'string' && pattern.test(value);

export function validatedSpec(input) {
  if (!string(input.taskId, /^[a-z0-9][a-z0-9-]{0,47}$/) ||
      !string(input.repository, /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/) ||
      !string(input.routineId, /^trig_[A-Za-z0-9_-]+$/) ||
      !string(input.baseBranch, /^[A-Za-z0-9_-]+$/) ||
      !string(input.baseSha, /^[a-f0-9]{40}$/)) fail('Invalid task target');
  for (const key of ['objective', 'acceptance']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 4000) fail('Invalid assignment');
  }
  if (!Array.isArray(input.allowedPaths) || !input.allowedPaths.length || input.allowedPaths.length > 10 ||
      input.allowedPaths.some(p => !string(p, /^[A-Za-z0-9_./-]+\.[A-Za-z0-9]+$/) || p.includes('..') || p.startsWith('/') || p.startsWith('.') || p.includes('/.'))) {
    fail('Expected explicit relative allowed file paths');
  }
  if (!Array.isArray(input.requiredChecks) || !input.requiredChecks.length || input.requiredChecks.some(c =>
    !string(c.name, /^[A-Za-z0-9_ /-]{1,80}$/) || !Number.isSafeInteger(c.appId) || c.appId < 1)) fail('Required checks must name a trusted GitHub App');
  // Reject extra input fields rather than silently persisting prompt-supplied authority.
  const spec = { taskId: input.taskId, repository: input.repository, visibility: input.visibility, routineId: input.routineId,
    baseBranch: input.baseBranch, baseSha: input.baseSha, objective: input.objective,
    acceptance: input.acceptance, allowedPaths: [...input.allowedPaths].sort(),
    requiredChecks: input.requiredChecks.map(c => ({ name: c.name, appId: c.appId })),
    mode: input.mode };
  if (!['public', 'private'].includes(spec.visibility) || !['synthetic', 'live'].includes(spec.mode) || Object.keys(input).some(k => !(k in spec))) fail('Invalid task fields');
  return spec;
}
