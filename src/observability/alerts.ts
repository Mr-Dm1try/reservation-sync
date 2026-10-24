import { Injectable, Logger } from '@nestjs/common';

/**
 * Things that "should never happen" and need a human to look (DECISIONS.md, section 2).
 * In production these would be error logs + metrics wired to alerting; here we log at
 * error level and keep counters so tests can assert on them.
 */
@Injectable()
export class Alerts {
  private readonly logger = new Logger('Alerts');
  readonly counts = { timestampTie: 0 };

  /** Two different events for one reservation share the same occurredAt. */
  timestampTie(reservationId: string, storedEventId: string, incomingEventId: string): void {
    this.counts.timestampTie++;
    this.logger.error(
      `reservation_event_timestamp_tie reservation=${reservationId} stored=${storedEventId} incoming=${incomingEventId}`,
    );
  }
}
