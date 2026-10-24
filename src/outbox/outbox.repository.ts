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
  /** The reservation's status right now, so the caller can decide whether to still send. */
  reservationStatus: ReservationStatus | undefined;
};

export type OutboxEntryView = {
  key: string;
  reservationId: string;
  kind: string;
  status: 'pending' | 'sent' | 'skipped';
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string;
  sentAt: string | null;
};

/** SQL for the transactional outbox. No business rules here; see outbox-policy.ts. */
@Injectable()
export class OutboxRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Insert-once by key, inside the caller's transaction (the one that changed the state).
   * A 'skipped' entry is revived: its message never went out. A pending or sent one is left alone.
   */
  async enqueue(tx: Queryable, entry: NewOutboxEntry): Promise<void> {
    await tx.query(
      `INSERT INTO outbox (key, reservation_id, kind, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE
       SET status = 'pending', payload = EXCLUDED.payload, attempts = 0, next_attempt_at = now(), last_error = NULL
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

  async markFailed(key: string, error: string, retryInMs: number): Promise<void> {
    await this.db.query(
      `UPDATE outbox SET last_error = $2, next_attempt_at = now() + $3 * interval '1 millisecond' WHERE key = $1`,
      [key, error, retryInMs],
    );
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending'`);
    return row.n;
  }

  async list(): Promise<OutboxEntryView[]> {
    const rows = await this.db.query<Record<string, any>>(
      `SELECT key, reservation_id, kind, status, attempts, last_error, next_attempt_at, sent_at
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
    }));
  }
}
