import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { Db } from '../src/db/db';
import { createPgliteDb } from '../src/db/pglite-db';
import { createPostgresDb } from '../src/db/postgres-db';

/** Which database the suites run on: TEST_DATABASE_URL set = real Postgres (`npm run test:pg`). */
export const testDbKind = process.env.TEST_DATABASE_URL ? 'postgres' : 'pglite';

/**
 * A fresh, empty database for one test file. On Postgres that is a new schema (Jest runs files in
 * parallel against one server), dropped again on close.
 */
export async function createTestDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return createPgliteDb();

  const schema = `test_${randomUUID().replace(/-/g, '')}`;
  await admin(url, `CREATE SCHEMA ${schema}`);
  const db = await createPostgresDb(url, { schema });
  return {
    ...db,
    async close() {
      await db.close();
      await admin(url, `DROP SCHEMA ${schema} CASCADE`);
    },
  };
}

async function admin(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}
