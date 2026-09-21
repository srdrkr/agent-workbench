import { notifyFollowThrough } from '../../hosted/follow-through.js';
import { getHostedRuntime } from '../../hosted/runtime.js';
import { ProgressMonitor, monitorAuthorized } from '../../hosted/monitor.js';
import { telegramConfig, sendProgressNotification, sendFollowThroughNotification } from '../../hosted/telegram.js';
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  if (!monitorAuthorized(toWebRequest(event), process.env.WORKBENCH_MONITOR_SECRET)) {
    setResponseStatus(event, 403); return { error: 'DENIED' };
  }
  try {
    const { store, steward, followThrough } = await getHostedRuntime();
    let notify = null;
    if (process.env.TELEGRAM_BOT_TOKEN) { const config = telegramConfig(); notify = job => sendProgressNotification(config, job); }
    const progress = await new ProgressMonitor({ store, coding: steward.coding, notify }).run();
    if (followThrough) {
      await followThrough.run();
      if (process.env.TELEGRAM_BOT_TOKEN) {
        const config = telegramConfig();
        await notifyFollowThrough({ store, send: text => sendFollowThroughNotification(config, text) });
      }
    }
    return progress;
  } catch { setResponseStatus(event, 503); return { error: 'PROGRESS_UNAVAILABLE' }; }
});
