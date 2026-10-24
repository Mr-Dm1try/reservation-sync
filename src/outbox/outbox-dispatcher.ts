import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EMAIL_SENDER, EmailSender } from '../email/email-sender';
import { Metrics } from '../observability/metrics';
import { retryDelayMs, sendDecision } from './outbox-policy';
import { OutboxRepository } from './outbox.repository';

export const DISPATCHER_INTERVAL_MS = Symbol('DISPATCHER_INTERVAL_MS');

const BATCH_SIZE = 20;
/** A claimed entry is invisible to other dispatchers for this long; if we crash mid-send, it comes back. */
const LEASE_MS = 60_000;

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
    private readonly outbox: OutboxRepository,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(DISPATCHER_INTERVAL_MS) private readonly intervalMs: number | null,
    private readonly metrics: Metrics,
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
    const claimed = await this.outbox.claim({ limit: BATCH_SIZE, leaseMs: LEASE_MS, ignoreBackoff });

    for (const entry of claimed) {
      // Rules live in outbox-policy.ts. A cancel that commits between the claim and this entry's
      // send still slips through; closing that would mean holding a lock across the network call.
      const decision = sendDecision(entry.kind, entry.reservationStatus);
      // False = the reservation changed since the claim (e.g. confirmed again), so send after all.
      if (decision.action === 'skip' && (await this.outbox.markSkipped(entry, decision.reason))) {
        this.metrics.outboxSends.inc({ result: 'skipped' });
        continue;
      }
      try {
        await this.sender.send({ idempotencyKey: entry.key, reservationId: entry.reservationId, ...entry.payload });
        await this.outbox.markSent(entry.key);
        this.metrics.outboxSends.inc({ result: 'sent' });
      } catch (err) {
        this.metrics.outboxSends.inc({ result: 'failed' });
        const delayMs = retryDelayMs(entry.attempts);
        await this.outbox.markFailed(entry.key, String(err instanceof Error ? err.message : err), delayMs);
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
    const n = await this.outbox.pendingCount();
    if (n > 0) throw new Error(`Outbox not idle after ${maxRounds} rounds: ${n} entries pending`);
  }
}
