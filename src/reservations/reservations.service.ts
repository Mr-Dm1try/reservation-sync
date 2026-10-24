import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { eventEnvelopeSchema, isKnownEventType, reservationEventSchema } from '../events/reservation-event';
import { Alerts } from '../observability/alerts';
import { Outcome } from './decide';
import { ReservationsRepository } from './reservations.repository';

export type WebhookOutcome = Outcome | 'ignored';

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly repo: ReservationsRepository,
    private readonly alerts: Alerts,
  ) {}

  /** Two-phase parse (envelope, then full event for known types), then apply. */
  async receive(body: unknown): Promise<{ outcome: WebhookOutcome }> {
    const envelope = eventEnvelopeSchema.safeParse(body);
    if (!envelope.success) throw invalid(envelope.error.issues);

    if (!isKnownEventType(envelope.data.type)) {
      this.logger.warn(`ignored unknown event type=${envelope.data.type} eventId=${envelope.data.eventId}`);
      return { outcome: 'ignored' };
    }

    const parsed = reservationEventSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const event = parsed.data;

    const result = await this.repo.apply(event);
    if (result.tie) this.alerts.timestampTie(event.reservationId, result.storedEventId!, event.eventId);
    this.logger.log(`event=${event.eventId} reservation=${event.reservationId} outcome=${result.outcome}`);
    return { outcome: result.outcome };
  }
}

function invalid(issues: unknown) {
  return new BadRequestException({ statusCode: 400, message: 'Invalid event', issues });
}
