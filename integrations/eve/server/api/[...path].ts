import { getHostedHandler } from '../../hosted/runtime.js';
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store');
  try { return await (await getHostedHandler())(toWebRequest(event)); }
  catch { setResponseStatus(event, 503); return { error: 'STEWARD_UNAVAILABLE' }; }
});
