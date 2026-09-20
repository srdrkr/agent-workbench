import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { authOptions } from './auth.js';
import { HostedStore, stateSchema } from './store.js';
import { initialState } from './steward.js';
export async function setupHosted(pool, { origin, secret, ownerEmail, password, project, budgetMicros }) {
  if (!ownerEmail || ownerEmail !== ownerEmail.toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || typeof password !== 'string' || password.length < 16 || password.length > 128) throw new Error('OWNER_CONFIGURATION_INVALID');
  const state = initialState(project, { model: 'anthropic/claude-opus-5', budgetMicros });
  const options = authOptions(pool, { origin, secret });
  const migration = await getMigrations(options);
  await migration.runMigrations();
  await pool.query(stateSchema);
  const users = await pool.query('SELECT id, email FROM "user"');
  if (users.rows.some(user => user.email.toLowerCase() !== ownerEmail)) throw new Error('DATABASE_NOT_OWNER_ONLY');
  if (!users.rows.length) {
    // This instance is never mounted to HTTP. Public instances disable signup.
    const bootstrap = betterAuth({ ...options, emailAndPassword: { ...options.emailAndPassword, disableSignUp: false } });
    await bootstrap.api.signUpEmail({ body: { email: ownerEmail, password, name: 'Project owner' } });
  }
  const store = new HostedStore(pool, { ownerId: ownerEmail, projectId: project.id });
  const existing = await pool.query('SELECT project_id FROM workbench_state WHERE owner_id=$1', [ownerEmail]);
  if (existing.rows.length) throw new Error('PROJECT_ALREADY_INITIALIZED_NO_CHANGES');
  await store.initialize(state);
  return { initialized: true, projectId: project.id, budgetMicros };
}
