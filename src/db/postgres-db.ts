import { Pool, PoolClient } from 'pg';
import { Db, Queryable } from './db';
import { SCHEMA_SQL } from './schema';

/** Any fixed key works; it only has to be the same for every instance running the schema. */
const SCHEMA_LOCK_KEY = 7_270_411;

export type PostgresDbOptions = {
  /** Sets search_path on every connection, so tests can isolate themselves in a schema. */
  schema?: string;
  max?: number;
};

/**
 * Real Postgres via a node-postgres Pool. Unlike PGlite (one connection, so transactions run one
 * after another), concurrent requests here get their own connections and really race; the row
 * locks and SKIP LOCKED in the repositories are what keeps them correct (DECISIONS.md, section 5).
 *
 * Types match the PGlite adapter with pg's defaults: timestamptz -> Date, jsonb -> parsed, int4
 * -> number. int8 (e.g. a bare count(*)) would come back as a string, hence `count(*)::int` in SQL.
 */
export async function createPostgresDb(connectionString: string, options: PostgresDbOptions = {}): Promise<Db> {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    options: options.schema ? `-c search_path=${options.schema}` : undefined,
  });
  // An idle client erroring (e.g. the server restarted) must not crash the process; the next checkout reconnects.
  pool.on('error', () => undefined);

  try {
    await migrate(pool);
  } catch (err) {
    await pool.end();
    throw err;
  }

  const wrap = (q: Pool | PoolClient): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await q.query(sql, params);
      return result.rows as T[];
    },
  });

  return {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * CREATE TABLE IF NOT EXISTS is not safe when two instances start at once: both can pass the
 * "exists?" check and one fails on a duplicate catalog entry. An advisory lock makes them take turns.
 */
async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    try {
      await client.query(SCHEMA_SQL);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
