import { createHash, timingSafeEqual } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function monitorAuthorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return request.method === 'POST' && actual.length === expected.length && timingSafeEqual(actual, expected);
}
const meaningful = j => ({ id: j.id, result: j.result?.result, head: j.result?.headSha,
  merge: j.result?.mergeCommitSha, checks: j.result?.requiredChecks?.map(c => [c.name, c.status, c.conclusion]) });
export class ProgressMonitor {
  constructor({ store, coding, notify = null, now = () => new Date().toISOString() }) {
    this.store = store; this.coding = coding; this.notify = notify; this.now = now;
  }
  async run() {
    const start = await this.store.change(state => {
      state.monitor ??= { notifications: {} };
      const m = state.monitor;
      if (!state.pilot || (m.lastStartedAt && Date.parse(this.now()) - Date.parse(m.lastStartedAt) < 10 * 60000)) return null;
      m.lastStartedAt = this.now();
      // One known job per tick bounds anonymous GitHub API use. Merged/abandoned jobs stop polling.
      const jobs = Object.values(state.coding?.jobs ?? {}).filter(j => ['accepted', 'unknown'].includes(j.dispatch)
        && j.result?.result !== 'merged_pr' && Date.parse(j.dispatchStartedAt) > Date.parse(this.now()) - 14 * 86400000);
      const job = jobs.sort((a, b) => (a.result?.observedAt ?? '').localeCompare(b.result?.observedAt ?? ''))[0];
      return job ? { id: job.id, before: hash(meaningful(job)) } : { id: null };
    });
    if (!start) return { skipped: true };
    let job;
    try {
      if (start.id) job = await this.coding.reconcile({ requestId: start.id });
      await this.store.change(state => { state.monitor.lastCheckedAt = this.now(); state.monitor.lastError = null; });
    } catch {
      await this.store.change(state => { state.monitor.lastCheckedAt = this.now(); state.monitor.lastError = 'GitHub check unavailable; prior progress retained.'; });
      return { checked: false };
    }
    if (!this.notify) return { checked: true };
    // Scan current durable facts independently of polling eligibility. A crash between
    // reconciliation and this transaction cannot lose a merged-result notification.
    const pending = await this.store.change(state => {
      const m = state.monitor; m.notifications ??= {};
      for (const n of Object.values(m.notifications)) {
        if (n.status === 'send_intent' && Date.parse(this.now()) - Date.parse(n.at) > 120000) {
          n.status = 'delivery_unknown'; m.notificationStatus = 'Update delivery uncertain; not resent';
        }
      }
      const result = Object.values(state.coding?.jobs ?? {}).filter(j => j.result && j.result.result !== 'not_found')
        .sort((a, b) => b.dispatchStartedAt.localeCompare(a.dispatchStartedAt))
        .find(j => !Object.hasOwn(m.notifications, hash(meaningful(j))));
      if (!result) return null;
      const key = hash(meaningful(result));
      m.notifications[key] = { status: 'send_intent', at: this.now(), requestId: result.id };
      m.notificationStatus = 'Sending a progress update'; return { key, job: result };
    });
    if (pending) {
      let sent = false;
      try { sent = await this.notify(pending.job); } catch { /* Uncertain delivery must not be repeated. */ }
      await this.store.change(state => {
        state.monitor.notifications[pending.key].status = sent ? 'sent' : 'delivery_unknown';
        state.monitor.notificationStatus = sent ? 'Latest progress update sent' : 'Update delivery uncertain; not resent';
      });
    }
    return { checked: true, changed: Boolean(pending) };
  }
}
