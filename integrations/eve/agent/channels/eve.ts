import { timingSafeEqual } from 'node:crypto';
import { eveChannel } from 'eve/channels/eve';

export default eveChannel({
  auth: [async request => {
    const expected = process.env.WORKBENCH_EVE_ACCESS_TOKEN;
    const supplied = request.headers.get('authorization');
    if (!expected || expected.length < 24 || !supplied) return null;
    const left = Buffer.from(supplied);
    const right = Buffer.from(`Bearer ${expected}`);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    return { authenticator: 'workbench', issuer: 'workbench', principalId: 'owner', principalType: 'user', attributes: {} };
  }],
});
