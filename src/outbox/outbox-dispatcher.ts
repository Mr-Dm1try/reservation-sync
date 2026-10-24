import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DB, Db } from '../db/db';
import { EMAIL_SENDER, EmailSender } from '../email/email-sender';

export const DISPATCHER_INTERVAL_MS = Symbol('DISPATCHER_INTERVAL_MS');

/**
 * Sends pending outbox entries (DECISIONS.md, section 4).
 * STEP 2 TODO: claim rows with FOR UPDATE SKIP LOCKED, send with the outbox key as the
 * idempotency key, mark sent; on failure increment attempts and back off via next_attempt_at.
 */
@Injectable()
export class OutboxDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(DISPATCHER_INTERVAL_MS) private readonly intervalMs: number | null,
  ) {}

  /** Starts background polling, unless the interval is null (tests drive it by hand). */
  start(): void {
    if (this.intervalMs === null || this.timer) return;
    this.timer = setInterval(() => {
      this.drainOnce().catch((err) => this.logger.error(err));
    }, this.intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Processes one batch of due entries. Returns how many entries were attempted. */
  async drainOnce(): Promise<number> {
    // STEP 2 TODO
    return 0;
  }

  /**
   * Keeps draining until nothing is pending, ignoring backoff delays, so tests can settle
   * deterministically without sleeping. Throws if entries are still pending after maxRounds.
   */
  async drainUntilIdle(maxRounds = 20): Promise<void> {
    // STEP 2 TODO
    void maxRounds;
  }
}
