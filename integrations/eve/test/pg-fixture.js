import { PGlite } from '@electric-sql/pglite';
// A real PostgreSQL WASM engine behind the pg Pool interface. Its single
// connection is serialized here; remote pool/network behavior needs a live smoke.
export class TestPool {
  constructor(path) { this.engine = new PGlite(path); this.tail = Promise.resolve(); }
  async connect() {
    const previous = this.tail; let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    return { query: async (sql, params) => { const result = await this.engine.query(sql, params); return { ...result, rowCount: result.affectedRows ?? result.rows.length }; }, release };
  }
  async query(sql, params) { const connection = await this.connect(); try { return await connection.query(sql, params); } finally { connection.release(); } }
  async end() { await this.tail; await this.engine.close(); }
}
