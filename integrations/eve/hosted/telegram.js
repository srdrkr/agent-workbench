import { timingSafeEqual, createHash } from 'node:crypto';
const fail = code => { throw new Error(code); };
const response = (status, error) => Response.json(error ? { error } : { ok: true }, { status, headers: { 'cache-control': 'no-store' } });
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const timestamp = () => new Date().toISOString();

export function telegramConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  const userId = Number(env.TELEGRAM_OWNER_USER_ID);
  const chatId = Number(env.TELEGRAM_OWNER_CHAT_ID);
  if (!token || !/^[0-9]+:[A-Za-z0-9_-]{20,}$/.test(token) || !secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)
      || !positiveId(userId) || chatId !== userId) fail('TELEGRAM_NOT_CONFIGURED');
  const origin = new URL(env.APP_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.APP_ORIGIN) fail('TELEGRAM_NOT_CONFIGURED');
  return { token, secret, userId, chatId, origin: origin.origin, botId: token.split(':')[0] };
}

export class TelegramChannel {
  constructor({ config, store, steward, send = fetch, now = timestamp }) {
    this.config = config; this.store = store; this.steward = steward; this.send = send; this.now = now;
    this.binding = createHash('sha256').update(JSON.stringify({ botId: config.botId, userId: config.userId, chatId: config.chatId })).digest('hex');
  }
  async receive(request, schedule) {
    const supplied = Buffer.from(request.headers.get('x-telegram-bot-api-secret-token') ?? '');
    const expected = Buffer.from(this.config.secret);
    if (request.method !== 'POST' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return response(403, 'DENIED');
    if (!request.headers.get('content-type')?.startsWith('application/json')) return response(400, 'INVALID_REQUEST');
    const reader = request.body?.getReader(); if (!reader) return response(400, 'INVALID_REQUEST');
    const parts = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); return response(413, 'INVALID_REQUEST'); } parts.push(Buffer.from(value)); }
    let update; try { update = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return response(400, 'INVALID_REQUEST'); }
    const m = update?.message;
    // Silently ignore strangers, groups, forwards, edits and non-text updates.
    // Nothing received over Telegram changes the fixed owner binding.
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0 || !m || !positiveId(m.message_id)
      || m.chat?.type !== 'private' || m.chat.id !== this.config.chatId || m.from?.id !== this.config.userId
      || m.from.is_bot || m.forward_origin || m.via_bot || typeof m.text !== 'string' || !m.text.trim()) return response(200);
    const text = m.text.trim();
    const id = `tg-${this.config.botId}-${update.update_id}`;
    const accepted = await this.store.change(state => {
      state.telegram ??= { binding: this.binding, updates: {} };
      if (state.telegram.binding !== this.binding) fail('TELEGRAM_BINDING_CHANGED');
      if (Object.hasOwn(state.telegram.updates, id)) return false;
      if (Object.keys(state.telegram.updates).length >= (state.pilot ? 5000 : 200)) fail('TELEGRAM_PILOT_LIMIT');
      state.telegram.updates[id] = { id, messageId: m.message_id, status: 'accepted', receivedAt: this.now(), projectId: state.project.id, contextRevision: state.project.revision };
      return true;
    });
    if (accepted) schedule(this.process(id, text).catch(() => {}));
    return response(200);
  }
  async process(id, text) {
    let reply;
    try {
      if (text.length > 2000) {
        reply = 'Please keep your question under 2,000 characters. No model request was sent.';
      } else if (['/start', '/help'].includes(text)) {
        reply = 'Send a question about the approved project brief. /status shows current decisions; /pause stops new model requests. Review and approve commitments in the web app. Coding availability is shown in the web app.';
      } else if (text === '/status') {
        const view = await this.steward.view();
        const updates = (await this.store.read()).telegram.updates;
        const uncertain = Object.values(updates).filter(u => u.id !== id && u.status !== 'sent').length;
        reply = `${view.project.name}\n${view.paused ? 'Model requests paused.' : 'Model requests enabled.'}\n${view.providerAttempts}/${view.maxProviderAttempts} model attempts; ${view.commitments.length} approved commitments.\n${view.requests.filter(r => !r.contextRevision || r.contextRevision === view.project.revision).map(r => `${r.status}: ${r.proposal?.title ?? 'Request saved; outcome not verified'}`).join('\n') || 'No requests yet.'}${uncertain ? `\n${uncertain} text delivery/update(s) need review. No automatic resend.` : ''}`;
      } else if (text === '/pause') {
        await this.steward.pause(); reply = 'New model requests are paused. An already-started request may still complete.';
      } else if (text.startsWith('/')) {
        reply = 'Use /status, /pause, or send a plain-text question. Approvals happen in the web app.';
      } else {
        const received = (await this.store.read()).telegram.updates[id];
        const result = await this.steward.propose({ requestId: id, projectId: received.projectId, expectedContextRevision: received.contextRevision, message: text });
        reply = result.proposal ? `${result.proposal.title}\n\n${result.proposal.rationale}\n\nSources: ${result.proposal.citations.join(', ')}${result.proposal.question ? `\n\n${result.proposal.question}` : ''}\n\n${result.proposal.kind === 'coding' ? 'Review this coding proposal in the web app. No work was dispatched by this message.' : 'This is a proposal. It has not been approved.'}` : 'Eve did not return a verified proposal. The attempt is held for review; it will not be retried automatically.';
      }
    } catch { reply = 'The request could not be completed. Check the web app for current context, allowance, and any held attempt.'; }
    const payload = { chat_id: this.config.chatId, text: `${reply.slice(0,3600)}\n\nReview: ${this.config.origin}`, link_preview_options: { is_disabled: true } };
    // Commit send intent first. Telegram has no application idempotency key for
    // sendMessage, so a lost response stays unknown instead of sending twice.
    const admitted = await this.store.change(state => {
      const update = state.telegram.updates[id];
      if (update.status !== 'accepted') return false;
      update.status = 'send_intent'; update.sendIntentAt = this.now(); return true;
    });
    if (!admitted) return;
    let messageId;
    try {
      const result = await this.send(`https://api.telegram.org/bot${this.config.token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      const body = await result.json();
      if (result.ok && body.ok === true && positiveId(body.result?.message_id) && body.result.chat?.id === this.config.chatId) messageId = body.result.message_id;
    } catch { /* Never persist raw URL/error: it can contain the bot token. */ }
    await this.store.change(state => { const update = state.telegram.updates[id]; update.status = messageId ? 'sent' : 'delivery_unknown'; update.observedAt = this.now(); if (messageId) update.sentMessageId = messageId; });
  }
}

export async function sendProgressNotification(config, job, send = fetch) {
  const labels = { tested_draft_pr: 'Draft PR ready: required checks passed', merged_pr: 'PR merged',
    needs_review: 'Coding result needs review', branch_without_pr: 'Claude pushed a branch; no matching PR yet',
    conflicting_prs: 'More than one PR matches this task', not_found: 'No matching GitHub result yet' };
  const text = `${labels[job.result?.result] ?? 'Coding progress changed'}\n${job.spec.objective.slice(0, 400)}\n${job.result?.prUrl ?? ''}\n${job.releasedAt ? 'Coding run closed.' : 'Claude session completion still needs confirmation in Steward.'}\n\nReview: ${config.origin}`;
  const result = await send(`https://api.telegram.org/bot${config.token}/sendMessage`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: config.chatId, text,
      link_preview_options: { is_disabled: true } }), redirect: 'error', signal: AbortSignal.timeout(10000) });
  const body = await result.json();
  return result.ok && body.ok === true && positiveId(body.result?.message_id) && body.result.chat?.id === config.chatId;
}
