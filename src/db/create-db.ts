import { Db } from './db';

export type DbConfig = { databaseUrl?: string; pgliteDataDir?: string };

/** DATABASE_URL set = real Postgres; otherwise PGlite (zero setup, in-memory unless a data dir is given). */
export async function createDb(config: DbConfig): Promise<{ db: Db; kind: 'postgres' | 'pglite' }> {
  if (config.databaseUrl) {
    const { createPostgresDb } = await import('./postgres-db');
    return { db: await createPostgresDb(config.databaseUrl), kind: 'postgres' };
  }
  const { createPgliteDb } = await import('./pglite-db');
  return { db: await createPgliteDb(config.pgliteDataDir), kind: 'pglite' };
}
