import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DB, Db } from '../db/db';
import { EMAIL_SENDER, EmailSender } from '../email/email-sender';

export const DISPATCHER_INTERVAL_MS = Symbol('DISPATCHER_INTERVAL_MS');

const BATCH_SIZE = 20;
/** A claimed entry is invisible to other dispatchers for this long; if we crash mid-send, it comes back. */
const LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;

type ClaimedEntry = {
  key: string;
  reservation_id: string;
  payload: { to: string; subject: string; body: string };
  attempts: number;
};

/**
 * Sends pending outbox entries (DECISIONS.md, section 4).
 *
 * Claim, then send outside any transaction, then mark. The claim is one statement: it picks due
 * rows with FOR UPDATE SKIP LOCKED (so concurrent dispatchers never pick the same row) and pushes
 * their next_attempt_at out by a lease, so no row lock is held during the network call. A crash
 * after the send but before the mark means a resend once the lease expires; the provider-side
 * idempotency key (the outbox key) stops that from reaching the guest twice.
 *
 * Entries whose reservation is cancelled by the time we get to them are marked 'skipped', not
 * sent (DECISIONS.md, section 4). Within one process, batches never overlap (the timer and
 * drainUntilIdle take turns), so ignoring backoff can't re-claim a row that is being sent.
 */
@Injectable()
export class OutboxDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(DISPATCHER_INTERVAL_MS) private readonly intervalMs: number | null,
  ) {}

  /** Starts background polling, unless the interval is null (tests drive it by hand). */
  start(): void {
    if (this.intervalMs === null || this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // previous tick still sending
      this.drainOnce().catch((err) => this.logger.error(err));
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Processes one batch of due entries. Returns how many entries were attempted.
   * `ignoreBackoff` treats every pending entry as due (used by drainUntilIdle).
   */
  async drainOnce({ ignoreBackoff = false } = {}): Promise<number> {
    // Wait for our own in-flight batch; waiters resume one at a time, so only one wins the slot.
    while (this.running) await this.running.catch(() => undefined);
    this.running = this.drainBatch(ignoreBackoff);
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async drainBatch(ignoreBackoff: boolean): Promise<number> {
    // Cancelled since the entry was written: don't tell the guest it's confirmed. A cancel that
    // commits between this check and the send still slips through; closing that would mean
    // holding a lock across the network call.
    await this.db.query(
      `UPDATE outbox o SET status = 'skipped', last_error = 'reservation cancelled before send'
       FROM reservations_last_event r
       WHERE o.status = 'pending' AND r.reservation_id = o.reservation_id AND r.status = 'cancelled'`,
    );

    const claimed = await this.db.query<ClaimedEntry>(
      `UPDATE outbox
       SET attempts = attempts + 1, next_attempt_at = now() + $1 * interval '1 millisecond'
       WHERE key IN (
         SELECT key FROM outbox
         WHERE status = 'pending' AND ($2 OR next_attempt_at <= now())
         ORDER BY next_attempt_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING key, reservation_id, payload, attempts`,
      [LEASE_MS, ignoreBackoff, BATCH_SIZE],
    );

    for (const entry of claimed) {
      try {
        await this.sender.send({ idempotencyKey: entry.key, reservationId: entry.reservation_id, ...entry.payload });
        await this.db.query(
          `UPDATE outbox SET status = 'sent', sent_at = now(), last_error = NULL WHERE key = $1`,
          [entry.key],
        );
      } catch (err) {
        const delayMs = Math.min(BACKOFF_BASE_MS * 2 ** (entry.attempts - 1), BACKOFF_MAX_MS);
        await this.db.query(
          `UPDATE outbox SET last_error = $2, next_attempt_at = now() + $3 * interval '1 millisecond'
           WHERE key = $1`,
          [entry.key, String(err instanceof Error ? err.message : err), delayMs],
        );
        this.logger.warn(`send failed key=${entry.key} attempt=${entry.attempts} retryInMs=${delayMs}: ${err}`);
      }
    }
    return claimed.length;
  }

  /**
   * Keeps draining until nothing is pending, ignoring backoff delays, so tests can settle
   * deterministically without sleeping. Throws if entries are still pending after maxRounds.
   * Safe next to this process's timer. It does re-claim rows leased by *another* process, so it
   * stays a test/demo helper for a single instance.
   */
  async drainUntilIdle(maxRounds = 20): Promise<void> {
    // With backoff ignored, a round that claims nothing means nothing is pending.
    for (let round = 0; round < maxRounds; round++) {
      if ((await this.drainOnce({ ignoreBackoff: true })) === 0) return;
    }
    const [{ n }] = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending'`);
    if (n > 0) throw new Error(`Outbox not idle after ${maxRounds} rounds: ${n} entries pending`);
  }
}
