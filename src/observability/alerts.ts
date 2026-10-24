import { Injectable, Logger } from '@nestjs/common';
import { Metrics } from './metrics';

/**
 * Things that "should never happen" and need a human to look (DECISIONS.md, section 2).
 * Each one is an error log plus a Prometheus counter (alert on any increase); `counts` mirrors
 * the counter so tests and the simulator can assert on it without parsing /metrics.
 */
@Injectable()
export class Alerts {
  private readonly logger = new Logger('Alerts');
  readonly counts = { timestampTie: 0 };

  constructor(private readonly metrics: Metrics) {}

  /**
   * Two different events for one reservation share the same occurredAt.
   * Counts deliveries, not anomalies: each redelivery of the losing event alerts again (no
   * processed-events store to remember it). Non-zero means "look"; exact counts only hold
   * when the delivery order is fixed.
   */
  timestampTie(reservationId: string, storedEventId: string, incomingEventId: string): void {
    this.counts.timestampTie++;
    this.metrics.timestampTies.inc();
    this.logger.error(
      `reservation_event_timestamp_tie reservation=${reservationId} stored=${storedEventId} incoming=${incomingEventId}`,
    );
  }
}
