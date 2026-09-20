import { Pool } from 'pg';

export const stateSchema = `CREATE TABLE IF NOT EXISTS workbench_state (
  owner_id TEXT NOT NULL, project_id TEXT NOT NULL, state JSONB NOT NULL,
  PRIMARY KEY (owner_id, project_id)
)`;

export function databasePool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_NOT_CONFIGURED');
  return new Pool({ connectionString, max: 3, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000, statement_timeout: 10000 });
}

// One owner/project aggregate. Row locks serialize short state transitions;
// neither inference nor routine I/O is performed inside these transactions.
export class HostedStore {
  constructor(pool, { ownerId, projectId }) {
    if (!ownerId || !projectId) throw new Error('SCOPE_REQUIRED');
    this.pool = pool; this.ownerId = ownerId; this.projectId = projectId;
  }
  async read() {
    const result = await this.pool.query('SELECT state FROM workbench_state WHERE owner_id=$1 AND project_id=$2', [this.ownerId, this.projectId]);
    if (!result.rows[0]) throw new Error('PROJECT_NOT_CONFIGURED');
    return result.rows[0].state;
  }
  async change(action) {
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await connection.query('SELECT state FROM workbench_state WHERE owner_id=$1 AND project_id=$2 FOR UPDATE', [this.ownerId, this.projectId]);
      if (!result.rows[0]) throw new Error('PROJECT_NOT_CONFIGURED');
      const state = result.rows[0].state;
      const value = action(state);
      if (value && typeof value.then === 'function') throw new Error('STATE_ACTION_MUST_BE_SYNCHRONOUS');
      await connection.query('UPDATE workbench_state SET state=$3::jsonb WHERE owner_id=$1 AND project_id=$2', [this.ownerId, this.projectId, JSON.stringify(state)]);
      await connection.query('COMMIT');
      return value;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => {}); throw error;
    } finally { connection.release(); }
  }
  async initialize(state) {
    await this.pool.query('INSERT INTO workbench_state(owner_id,project_id,state) VALUES($1,$2,$3::jsonb)', [this.ownerId, this.projectId, JSON.stringify(state)]);
  }
}
