import { waitUntil } from '@vercel/functions';
import { getHostedRuntime } from '../../hosted/runtime.js';
import { TelegramChannel, telegramConfig } from '../../hosted/telegram.js';
let channel;
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  if (!process.env.TELEGRAM_BOT_TOKEN) { setResponseStatus(event, 404); return { error: 'NOT_FOUND' }; }
  try {
    if (!channel) channel = new TelegramChannel({ ...(await getHostedRuntime()), config: telegramConfig() });
    return await channel.receive(toWebRequest(event), job => waitUntil(job));
  } catch { setResponseStatus(event, 503); return { error: 'TEXT_CHANNEL_UNAVAILABLE' }; }
});
