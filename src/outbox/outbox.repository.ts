import { Inject, Injectable } from '@nestjs/common';
import { DB, Db, Queryable } from '../db/db';
import { ReservationStatus } from '../events/reservation-event';

export type NewOutboxEntry = {
  key: string;
  reservationId: string;
  kind: string;
  payload: { to: string; subject: string; body: string };
};

export type ClaimedEntry = NewOutboxEntry & {
  attempts: number;
  /** Time since the current retry window started (insert, revive or bulk retry). */
  pendingForMs: number;
  /** The reservation's status right now, so the caller can decide whether to still send. */
  reservationStatus: ReservationStatus | undefined;
};

export type OutboxEntryView = {
  key: string;
  reservationId: string;
  kind: string;
  status: 'pending' | 'sent' | 'skipped' | 'failed';
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  sentAt: string | null;
  failedAt: string | null;
};

/** SQL for the transactional outbox. No business rules here; see outbox-policy.ts. */
@Injectable()
export class OutboxRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Insert-once by key, inside the caller's transaction (the one that changed the state).
   * A 'skipped' entry is revived with a fresh retry window: its message never went out. A pending,
   * sent or failed one is left alone (failed ones come back only through retryFailed).
   */
  async enqueue(tx: Queryable, entry: NewOutboxEntry): Promise<void> {
    await tx.query(
      `INSERT INTO outbox (key, reservation_id, kind, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE
       SET status = 'pending', payload = EXCLUDED.payload, attempts = 0, next_attempt_at = now(),
           pending_since = now(), last_error = NULL
       WHERE outbox.status = 'skipped'`,
      [entry.key, entry.reservationId, entry.kind, JSON.stringify(entry.payload)],
    );
  }

  /**
   * Claims up to `limit` pending entries in one statement: FOR UPDATE SKIP LOCKED so concurrent
   * dispatchers never pick the same row, and next_attempt_at pushed out by a lease so no lock is
   * held during the send. `ignoreBackoff` treats every pending entry as due.
   */
  async claim({ limit, leaseMs, ignoreBackoff }: { limit: number; leaseMs: number; ignoreBackoff: boolean }) {
    const rows = await this.db.query<Record<string, any>>(
      `UPDATE outbox o
       SET attempts = attempts + 1, next_attempt_at = now() + $1 * interval '1 millisecond'
       WHERE key IN (
         SELECT key FROM outbox
         WHERE status = 'pending' AND ($2 OR next_attempt_at <= now())
         ORDER BY next_attempt_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING key, reservation_id, kind, payload, attempts,
         (extract(epoch FROM now() - pending_since) * 1000)::float8 AS pending_for_ms,
         (SELECT status FROM reservations_last_event r WHERE r.reservation_id = o.reservation_id) AS reservation_status`,
      [leaseMs, ignoreBackoff, limit],
    );
    return rows.map(
      (r): ClaimedEntry => ({
        key: r.key,
        reservationId: r.reservation_id,
        kind: r.kind,
        payload: r.payload,
        attempts: r.attempts,
        pendingForMs: r.pending_for_ms,
        reservationStatus: r.reservation_status ?? undefined,
      }),
    );
  }

  async markSent(key: string): Promise<void> {
    await this.db.query(`UPDATE outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE key = $1`, [key]);
  }

  /**
   * Marks a claimed entry skipped, but only if its reservation's status is still the one the skip
   * was decided on (compare-and-set). Locks the reservation row first, the same order as the
   * webhook transaction, so a newer snapshot either lands before (we return false and the caller
   * sends) or after (it sees 'skipped' and revives the entry via enqueue).
   */
  markSkipped(entry: ClaimedEntry, reason: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.query<{ status: ReservationStatus }>(
        `SELECT status FROM reservations_last_event WHERE reservation_id = $1 FOR SHARE`,
        [entry.reservationId],
      );
      if (current?.status !== entry.reservationStatus) return false;
      const updated = await tx.query(
        `UPDATE outbox SET status = 'skipped', last_error = $2 WHERE key = $1 AND status = 'pending' RETURNING key`,
        [entry.key, reason],
      );
      return updated.length > 0;
    });
  }

  /** A send failed but the retry window allows another try: stays 'pending', due again after `retryInMs`. */
  async markRetry(key: string, error: string, retryInMs: number): Promise<void> {
    await this.db.query(
      `UPDATE outbox SET last_error = $2, next_attempt_at = now() + $3 * interval '1 millisecond' WHERE key = $1`,
      [key, error, retryInMs],
    );
  }

  /** Gives up on an entry: it stays as 'failed' (with its last error) until retryFailed. */
  async markDeadLettered(key: string, error: string): Promise<void> {
    await this.db.query(`UPDATE outbox SET status = 'failed', failed_at = now(), last_error = $2 WHERE key = $1`, [
      key,
      error,
    ]);
  }

  /**
   * Bulk requeue of dead-lettered entries, e.g. after a provider outage is fixed: back to
   * 'pending' with a fresh retry window. `failedSince` limits it to one incident. Only touches
   * 'failed' rows, so calling it twice is harmless. Returns the requeued keys.
   */
  async retryFailed({ failedSince }: { failedSince?: string } = {}): Promise<string[]> {
    const rows = await this.db.query<{ key: string }>(
      `UPDATE outbox
       SET status = 'pending', attempts = 0, next_attempt_at = now(), pending_since = now(), failed_at = NULL
       WHERE status = 'failed' AND ($1::timestamptz IS NULL OR failed_at >= $1::timestamptz)
       RETURNING key`,
      [failedSince ?? null],
    );
    return rows.map((r) => r.key);
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending'`);
    return row.n;
  }

  /** For the metrics gauges. */
  async countByStatus(): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM outbox GROUP BY status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** Seconds the oldest pending entry has been waiting (since it became pending); 0 if none is. */
  async oldestPendingAgeSeconds(): Promise<number> {
    const [row] = await this.db.query<{ age: number | null }>(
      `SELECT extract(epoch FROM now() - min(pending_since))::float8 AS age FROM outbox WHERE status = 'pending'`,
    );
    return row.age ?? 0;
  }

  async list(): Promise<OutboxEntryView[]> {
    const rows = await this.db.query<Record<string, any>>(
      `SELECT key, reservation_id, kind, status, attempts, last_error, next_attempt_at, sent_at, failed_at
       FROM outbox ORDER BY created_at, key`,
    );
    return rows.map((r) => ({
      key: r.key,
      reservationId: r.reservation_id,
      kind: r.kind,
      status: r.status,
      attempts: r.attempts,
      lastError: r.last_error,
      nextAttemptAt: new Date(r.next_attempt_at).toISOString(),
      sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
      failedAt: r.failed_at ? new Date(r.failed_at).toISOString() : null,
    }));
  }
}
