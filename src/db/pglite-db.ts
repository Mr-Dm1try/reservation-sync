import { PGlite } from '@electric-sql/pglite';
import { Db, Queryable } from './db';
import { SCHEMA_SQL } from './schema';

/** In-process Postgres. `dataDir` undefined = in-memory (fresh database, used by tests). */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const pg = await PGlite.create(dataDir);
  await pg.exec(SCHEMA_SQL);

  const wrap = (q: Pick<PGlite, 'query'>): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await q.query<T>(sql, params);
      return result.rows;
    },
  });

  return {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    close: () => pg.close(),
  };
}
