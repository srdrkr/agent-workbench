let state;
let pendingRequest;
const $ = id => document.getElementById(id);
const el = (tag, value, className) => { const node = document.createElement(tag); if (value) node.textContent = value; if (className) node.className = className; return node; };
const tell = value => { $('notice').textContent = value; };
const label = value => value.replaceAll('_', ' ');
async function api(path, input) {
  const response = await fetch(path, input ? { method: 'POST', headers: { 'Content-Type': 'application/json',
    'X-Workbench-CSRF': state.csrf }, body: JSON.stringify(input) } : {});
  const value = await response.json();
  if (response.status === 401) { $('login').hidden = false; $('workspace').hidden = true; }
  if (!response.ok) throw new Error(value.error);
  return value;
}
function button(text, callback, kind = '') {
  const node = el('button', text, kind);
  node.addEventListener('click', async () => {
    node.disabled = true; tell('');
    try { await callback(); await refresh(); } catch (error) { tell(error.message); node.disabled = false; }
  });
  return node;
}
function renderRequest(record) {
  const card = el('article', '', 'panel request');
  const top = el('div', '', 'section-label'); top.append(el('span', record.judge), el('span', label(record.status), 'pill')); card.append(top);
  card.append(el('p', record.message, 'request-input'));
  if (!record.proposal) { card.append(el('p', record.status === 'thinking' ? 'Judgment started. If the app restarted, this request stays held; it is not automatically replayed.' : 'Judgment was unavailable or failed validation. No authority was granted.', 'muted')); return card; }
  card.append(el('h3', record.proposal.title), el('p', record.proposal.rationale));
  const historicalSources = record.contextSnapshot?.sources ?? [];
  const citations = el('p', '', 'small');
  citations.textContent = `Sources: ${record.proposal.citations.map(id => historicalSources.find(s => s.id === id)?.title ?? `${id} (original snapshot unavailable)`).join(' · ')}`;
  card.append(citations);
  if (historicalSources.length) {
    const sources = el('details'); sources.append(el('summary', 'Context used for this decision'));
    for (const source of historicalSources.filter(s => record.proposal.citations.includes(s.id))) sources.append(
      el('strong', source.title), el('p', source.content), el('p', `Source revision: ${source.revision}`, 'small'));
    card.append(sources);
  }
  if (record.proposal.question) card.append(el('p', record.proposal.question, 'question'));
  const actions = el('div', '', 'actions');
  const exact = { requestId: record.id, proposalHash: record.proposalHash };
  const stale = record.contextRevision !== state.project.revision || !state.contextFresh;
  if (stale) card.append(el('p', 'Context changed or expired. Ask for a fresh proposal before approving.', 'warning'));
  if (record.task) {
    const task = record.task;
    const details = el('details'); details.append(el('summary', 'Review exact coding assignment'));
    details.append(el('p', task.spec.objective), el('p', task.spec.acceptance), el('p', `Allowed file: ${task.spec.allowedPaths.join(', ')}`, 'small'),
      el('p', `${task.spec.repository} · ${task.branch}`, 'mono'), el('p', `Base: ${task.spec.baseSha}`, 'mono'));
    card.append(details);
    const progress = el('div', '', 'progress');
    progress.append(el('span', `Dispatch: ${label(task.dispatch)}`), el('span', `Execution: ${label(task.execution)}`)); card.append(progress);
    if (task.dispatch !== 'not_sent') {
      if (task.dispatch === 'unknown') card.append(el('p', 'The response was lost. The assignment may have started. No second fire will be sent.', 'warning'));
      actions.append(button('Recover simulated evidence', () => api('/api/reconcile', { requestId: record.id }), 'quiet'));
    }
    if (task.result) {
      const result = el('div', '', 'result');
      result.append(el('strong', `Simulated result: ${label(task.result.result)}`));
      result.append(el('p', 'Fixture GitHub evidence, separate from a worker self-report. No real PR was created by this preview.', 'small'));
      for (const check of task.result.requiredChecks ?? []) result.append(el('p', `${check.name}: ${check.conclusion ?? check.status} · trusted app ${check.appId}`, 'small'));
      card.append(result);
    }
    if (!stale && task.dispatch === 'not_sent' && !state.controls.paused && !state.controls.active) {
      if (record.status === 'awaiting_approval') actions.append(button('Approve this assignment', () => api('/api/approve', exact)));
      else if (record.status === 'approved') {
        actions.append(button('Run simulated handoff', () => api('/api/dispatch', exact)));
        actions.append(button('Simulate a lost response', () => api('/api/dispatch', { ...exact, lostResponse: true }), 'quiet'));
      }
    }
  } else if (!stale && record.status === 'awaiting_approval') actions.append(button('Accept commitment', () => api('/api/approve', exact)));
  if (record.approval) card.append(el('p', `Approved by the local owner · ${new Date(record.approval.approvedAt).toLocaleString()}`, 'small'));
  card.append(actions); return card;
}
async function refresh() {
  state = await api('/api/state');
  $('login').hidden = true; $('workspace').hidden = false;
  $('project-name').textContent = state.project.name; $('objective').textContent = state.project.objective;
  $('freshness').textContent = state.contextFresh ? 'CURRENT' : 'REFRESH NEEDED';
  $('mode').textContent = state.judge === 'scripted demo' ? 'Scripted demo with synthetic context. No model calls, charges, or live coding dispatches.' : 'Eve runs locally with a fixed model fixture. This verifies the integration, not model judgment. Coding handoffs remain simulated.';
  $('sources').replaceChildren(...state.project.sources.map(source => {
    const node = el('div', '', 'source'); node.append(el('strong', source.title), el('p', source.content), el('p', `Revision ${source.revision} · ${source.exposure === 'local_only' ? 'Local only' : 'Approved for model context'}`, 'small')); return node;
  }));
  $('requests').replaceChildren(...state.requests.map(renderRequest));
  if (!state.requests.length) $('requests').append(el('div', 'No open decisions yet. Start with the next useful step.', 'empty'));
  $('request-count').textContent = `${state.requests.length} recorded`;
  $('commitments').replaceChildren(...state.commitments.map(c => el('p', c.title, 'commitment')));
  if (!state.commitments.length) $('commitments').append(el('p', 'Nothing accepted yet. Proposed commitments stay separate until you approve them.', 'muted'));
  $('admission').textContent = state.controls.paused ? 'Admission paused' : state.controls.active ? 'One assignment held' : 'Ready for one assignment';
  $('stop').disabled = Boolean(state.controls.paused);
  $('observed').replaceChildren();
  const result = state.observedResult;
  if (result) {
    const link = el('a', 'View merged PR #1 ↗');
    // This link is a server-owned public observation, never a model-supplied URL.
    link.href = 'https://github.com/srdrkr/workbench-routine-sandbox/pull/1'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    $('observed').append(el('p', result.checks), link, el('p', result.dispatch, 'small'), el('p', result.limits, 'small'), el('p', result.source, 'small'));
  }
}
$('request-form').addEventListener('submit', async event => {
  event.preventDefault(); $('send').disabled = true; tell('');
  const message = $('message').value.trim();
  if (!pendingRequest || pendingRequest.message !== message) pendingRequest = { requestId: crypto.randomUUID(), projectId: state.project.id, message };
  try { await api('/api/propose', pendingRequest); pendingRequest = null; $('message').value = ''; await refresh(); }
  catch (error) { tell(`${error.message} Retrying the same input preserves its request ID.`); }
  finally { $('send').disabled = false; }
});
document.querySelectorAll('[data-prompt]').forEach(node => node.addEventListener('click', () => { $('message').value = node.dataset.prompt; $('message').focus(); }));
$('refresh').addEventListener('click', () => refresh().catch(error => tell(error.message)));
$('stop').addEventListener('click', async () => { try { await api('/api/stop', {}); await refresh(); } catch (error) { tell(error.message); } });
$('logout').addEventListener('click', async () => { await api('/api/logout', {}); location.reload(); });
refresh().catch(error => tell(error.message));
