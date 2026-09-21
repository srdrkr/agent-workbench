export function followThroughNotice(f) {
  const labels = {
    ready_for_owner: 'Eve reviewed the PR. Review its findings and checks before merging.',
    waiting_for_provider_exit: 'Corrections are prepared. Confirm Claude finished so Eve can send them.',
    waiting_for_connection: 'Corrections are prepared; the bounded delivery connection needs setup.',
    blocked: `Eve stopped: ${f.reason ?? 'an owner decision is needed'}`,
  };
  return labels[f.status] ?? null;
}
