import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DB, Db } from '../db/db';
import {
  eventEnvelopeSchema,
  isKnownEventType,
  ReservationEvent,
  reservationEventSchema,
} from '../events/reservation-event';
import { Alerts } from '../observability/alerts';
import { Metrics } from '../observability/metrics';
import { OutboxRepository } from '../outbox/outbox.repository';
import { confirmationEntry } from './confirmation-email';
import { decide, Decision, Outcome } from './decide';
import { ReservationsRepository } from './reservations.repository';

export type WebhookOutcome = Outcome | 'ignored';

export type ApplyResult = Decision & {
  /** eventId of the stored record before this event, if there was one (for the tie alert). */
  storedEventId?: string;
};

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly reservations: ReservationsRepository,
    private readonly outbox: OutboxRepository,
    private readonly alerts: Alerts,
    private readonly metrics: Metrics,
  ) {}

  /** Two-phase parse (envelope, then full event for known types), then apply. */
  async receive(body: unknown): Promise<{ outcome: WebhookOutcome }> {
    const outcome = await this.process(body).catch((err) => {
      this.metrics.events.inc({ outcome: err instanceof BadRequestException ? 'rejected' : 'error' });
      throw err;
    });
    this.metrics.events.inc({ outcome });
    return { outcome };
  }

  private async process(body: unknown): Promise<WebhookOutcome> {
    const envelope = eventEnvelopeSchema.safeParse(body);
    if (!envelope.success) throw invalid(envelope.error.issues);

    if (!isKnownEventType(envelope.data.type)) {
      this.logger.warn(`ignored unknown event type=${envelope.data.type} eventId=${envelope.data.eventId}`);
      return 'ignored';
    }

    const parsed = reservationEventSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const event = parsed.data;

    const result = await this.apply(event);
    if (result.tie) this.alerts.timestampTie(event.reservationId, result.storedEventId!, event.eventId);
    this.logger.log(`event=${event.eventId} reservation=${event.reservationId} outcome=${result.outcome}`);
    return result.outcome;
  }

  /**
   * "Insert if absent, then lock the row and decide in code" (DECISIONS.md, section 5, option 1),
   * in one transaction. The primary key settles the race for the first write; the row lock
   * serializes everything after it, including the outbox write.
   */
  apply(event: ReservationEvent): Promise<ApplyResult> {
    return this.db.transaction(async (tx) => {
      let result: ApplyResult;
      if (await this.reservations.insertIfAbsent(tx, event)) {
        result = { outcome: 'applied', tie: false };
      } else {
        const current = await this.reservations.lockCurrent(tx, event.reservationId);
        result = { ...decide(current, event), storedEventId: current.lastEventId };
        if (result.outcome === 'applied') await this.reservations.replace(tx, event);
      }

      // Same transaction as the state change, so the email can't be lost or invented.
      if (result.outcome === 'applied' && event.data.status === 'confirmed') {
        await this.outbox.enqueue(tx, confirmationEntry(event));
      }
      return result;
    });
  }
}

function invalid(issues: unknown) {
  return new BadRequestException({ statusCode: 400, message: 'Invalid event', issues });
}
