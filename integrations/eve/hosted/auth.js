import { betterAuth } from 'better-auth';
export function authOptions(pool, { origin, secret }) {
  const url = new URL(origin);
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.origin !== origin || (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || secret?.length < 32 || !secret) throw new Error('AUTH_CONFIGURATION_INVALID');
  return { database: pool, baseURL: origin, secret, trustedOrigins: [origin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 16, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 60,
      customRules: { '/sign-in/email': { window: 60, max: 5 } } },
    advanced: { useSecureCookies: !local }, logger: { disabled: true },
  };
}
export const ownerAuth = (pool, config) => betterAuth(authOptions(pool, config));
export async function requireOwner(auth, request, ownerEmail, origin) {
  if (request.method !== 'GET' && request.headers.get('origin') !== origin) throw new Error('ORIGIN_DENIED');
  const session = await auth.api.getSession({ headers: request.headers });
  if (!ownerEmail || session?.user.email.toLowerCase() !== ownerEmail.toLowerCase()) throw new Error('UNAUTHORIZED');
  return session.user;
}
