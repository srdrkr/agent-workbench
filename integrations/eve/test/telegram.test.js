import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramChannel, telegramConfig } from '../hosted/telegram.js';
import { TestPool } from './pg-fixture.js';
import { HostedStore, stateSchema } from '../hosted/store.js';
const config = telegramConfig({ TELEGRAM_BOT_TOKEN: '12345:synthetic-telegram-test-token-1234', TELEGRAM_WEBHOOK_SECRET: 'synthetic-webhook-secret-thirty-two-chars', TELEGRAM_OWNER_USER_ID: '67890', TELEGRAM_OWNER_CHAT_ID: '67890', APP_ORIGIN: 'https://steward.example.com' });
const update = { update_id: 50, message: { message_id: 20, from: { id: 67890 }, chat: { id: 67890, type: 'private' }, text: 'What should I do next?' } };
const request = (body = update, secret = config.secret) => new Request('https://steward.example.com/api/telegram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(body) });
async function fixture(t, send) {
  const pool = new TestPool(); t.after(() => pool.end()); await pool.query(stateSchema);
  const store = new HostedStore(pool, { ownerId: 'owner@example.com', projectId: 'synthetic' }); await store.initialize({ paused: false, project: { id: 'synthetic' } });
  let calls = 0, sends = 0; const jobs = [];
  const steward = { async propose(input) { calls++; assert.equal(input.requestId, 'tg-12345-50'); return { proposal: { kind: 'commitment', title: 'Review the brief', rationale: 'Synthetic response.', citations: ['brief'] } }; },
    async view() { return { project: { name: 'Synthetic project' }, requests: [], commitments: [], providerAttempts: 0, maxProviderAttempts: 5 }; },
    async pause() { await store.change(state => { state.paused = true; }); } };
  const channel = new TelegramChannel({ config, store, steward, send: async (url, init) => { sends++; const state = await store.read(); assert.equal(Object.values(state.telegram.updates).at(-1).status, 'send_intent'); if (send) return send(url, init); const body = JSON.parse(init.body); assert.equal(body.chat_id, config.chatId); assert.equal(body.link_preview_options.is_disabled, true); assert.equal('parse_mode' in body, false); return Response.json({ ok: true, result: { message_id: 55, chat: { id: config.chatId } } }); } });
  return { channel, store, steward, jobs, schedule: job => jobs.push(job), counts: () => ({ calls, sends }) };
}

test('text channel fails closed for missing binding, wrong secret, groups and foreign users', async t => {
  assert.throws(() => telegramConfig({}), /NOT_CONFIGURED/);
  const f = await fixture(t);
  assert.equal((await f.channel.receive(request(update, 'wrong'), f.schedule)).status, 403);
  for (const change of [{ from: { id: 9 } }, { chat: { id: -1, type: 'group' } }, { forward_origin: {} }, { from: { id: 67890, is_bot: true } }]) {
    assert.equal((await f.channel.receive(request({ ...update, message: { ...update.message, ...change } }), f.schedule)).status, 200);
  }
  assert.deepEqual(f.counts(), { calls: 0, sends: 0 }); assert.equal(f.jobs.length, 0);
  assert.equal((await f.store.read()).telegram, undefined);
});

test('duplicate Telegram deliveries across instances create one proposal and one outbound message', async t => {
  const f = await fixture(t);
  const second = new TelegramChannel({ config, store: f.store, steward: f.steward, send: () => { throw new Error('duplicate send'); } });
  await Promise.all([f.channel.receive(request(), f.schedule), second.receive(request(), f.schedule)]);
  await Promise.all(f.jobs);
  assert.deepEqual(f.counts(), { calls: 1, sends: 1 });
  assert.equal((await f.store.read()).telegram.updates['tg-12345-50'].status, 'sent');
  await second.receive(request(), f.schedule);
  assert.equal(f.jobs.length, 1);
});

test('unknown delivery stays recorded after restart without exposing token or resending', async t => {
  const f = await fixture(t, async () => { throw new Error(config.token); });
  await f.channel.receive(request(), f.schedule); await Promise.all(f.jobs);
  assert.equal((await f.store.read()).telegram.updates['tg-12345-50'].status, 'delivery_unknown');
  await f.channel.receive(request(), f.schedule); await Promise.all(f.jobs);
  assert.deepEqual(f.counts(), { calls: 1, sends: 1 });
  assert.ok(!JSON.stringify(await f.store.read()).includes(config.token));
});

test('duplicate overlong messages are acknowledged once with no model request', async t => {
  const f = await fixture(t, async (_url, init) => {
    assert.match(JSON.parse(init.body).text, /under 2,000 characters/);
    return Response.json({ ok: true, result: { message_id: 55, chat: { id: config.chatId } } });
  });
  const longUpdate = { ...update, message: { ...update.message, text: 'x'.repeat(2001) } };
  for (let i = 0; i < 2; i++) assert.equal((await f.channel.receive(request(longUpdate), f.schedule)).status, 200);
  await Promise.all(f.jobs);
  assert.deepEqual(f.counts(), { calls: 0, sends: 1 });
  assert.equal(f.jobs.length, 1);
});

test('status, pause and approval-like commands do not invoke the model or approve work', async t => {
  const f = await fixture(t);
  for (const [index, text] of ['/status', '/pause', '/approve yes'].entries()) {
    await f.channel.receive(request({ ...update, update_id: index, message: { ...update.message, text } }), f.schedule);
    await Promise.all(f.jobs);
  }
  assert.equal(f.counts().calls, 0); assert.equal(f.counts().sends, 3); assert.equal((await f.store.read()).paused, true);
});

test('oversized webhook and changed owner binding cannot schedule work', async t => {
  const f = await fixture(t);
  assert.equal((await f.channel.receive(request({ ...update, padding: 'x'.repeat(17000) }), f.schedule)).status, 413);
  await f.store.change(state => { state.telegram = { binding: 'different', updates: {} }; });
  await assert.rejects(f.channel.receive(request(), f.schedule), /BINDING_CHANGED/);
  assert.equal(f.jobs.length, 0);
});
