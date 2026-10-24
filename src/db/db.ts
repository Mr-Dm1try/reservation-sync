/**
 * Minimal database port. The app only depends on this, so PGlite (in-process Postgres) can be
 * swapped for a real Postgres driver without touching business code (DECISIONS.md, section 5).
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs `fn` in a transaction: commit on resolve, rollback on throw. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const DB = Symbol('DB');
