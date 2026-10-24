import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Registry } from 'prom-client';
import { OutboxRepository } from '../outbox/outbox.repository';

export type EventOutcomeLabel = 'applied' | 'duplicate' | 'stale' | 'ignored' | 'rejected' | 'error';
export type SendResultLabel = 'sent' | 'failed' | 'skipped' | 'dead_lettered';

const OUTBOX_STATUSES = ['pending', 'sent', 'skipped', 'failed'] as const;

/**
 * Prometheus metrics, served at GET /metrics (DECISIONS.md, section 10).
 * One registry per app instance, not prom-client's global one, so tests can boot several apps
 * in one process without counters leaking between them.
 *
 * Counters are bumped where things happen; the outbox gauges are read from the database at
 * scrape time, so they are true across restarts and across dispatcher instances.
 */
@Injectable()
export class Metrics {
  readonly registry = new Registry();

  readonly events = new Counter({
    name: 'reservation_events_total',
    help: 'Webhook deliveries by outcome (applied, duplicate, stale, ignored = unknown type, rejected = 400, error = 500)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly timestampTies = new Counter({
    name: 'reservation_event_timestamp_tie_total',
    help: 'Deliveries whose occurredAt equals the stored one with a different eventId. Should be 0: alert on any increase',
    registers: [this.registry],
  });

  readonly outboxSends = new Counter({
    name: 'outbox_send_total',
    help: 'Outbox entries processed by result (sent, failed = will retry, skipped = reservation cancelled before send, dead_lettered = gave up after the retry window: alert on any increase)',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  constructor(outbox: OutboxRepository) {
    // Pre-create label sets so a rate() query sees 0 instead of "no data" before the first hit.
    for (const outcome of ['applied', 'duplicate', 'stale', 'ignored', 'rejected', 'error'] satisfies EventOutcomeLabel[]) {
      this.events.inc({ outcome }, 0);
    }
    for (const result of ['sent', 'failed', 'skipped', 'dead_lettered'] satisfies SendResultLabel[]) {
      this.outboxSends.inc({ result }, 0);
    }

    new Gauge({
      name: 'outbox_entries',
      help: 'Outbox entries by status, read from the database at scrape time',
      labelNames: ['status'] as const,
      registers: [this.registry],
      async collect() {
        const counts = await outbox.countByStatus();
        for (const status of OUTBOX_STATUSES) this.set({ status }, counts[status] ?? 0);
      },
    });

    new Gauge({
      name: 'outbox_oldest_pending_age_seconds',
      help: 'Age of the oldest pending outbox entry (0 if none). Growing means emails are stuck',
      registers: [this.registry],
      async collect() {
        this.set(await outbox.oldestPendingAgeSeconds());
      },
    });
  }
}
