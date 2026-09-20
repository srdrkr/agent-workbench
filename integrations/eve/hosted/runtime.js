import { databasePool, HostedStore } from './store.js';
import { ownerAuth } from './auth.js';
import { HostedSteward } from './steward.js';
import { hostedHandler } from './http.js';
import { HostedCoding, codingConfig } from './coding.js';
import { createEveJudge } from '../judge.js';
let runtime;
export async function getHostedRuntime() {
  runtime ??= (async () => {
    const origin = process.env.APP_ORIGIN;
    const ownerEmail = process.env.WORKBENCH_OWNER_EMAIL?.toLowerCase();
    const pool = databasePool(process.env.DATABASE_URL);
    const auth = ownerAuth(pool, { origin, secret: process.env.BETTER_AUTH_SECRET });
    const store = new HostedStore(pool, { ownerId: ownerEmail, projectId: process.env.WORKBENCH_PROJECT_ID });
    const judge = await createEveJudge({ enabled: process.env.WORKBENCH_EVE_MODE === 'hosted', hosted: true,
      host: process.env.WORKBENCH_EVE_ORIGIN || origin, authToken: process.env.WORKBENCH_EVE_ACCESS_TOKEN, timeoutMs: 60_000 });
    const coding = new HostedCoding(store, { config: codingConfig() });
    const steward = new HostedSteward(store, judge, { coding });
    return { store, steward, handler: hostedHandler({ auth, steward, ownerEmail, origin }) };
  })();
  return runtime;
}

export async function getHostedHandler() { return (await getHostedRuntime()).handler; }
