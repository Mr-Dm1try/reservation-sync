import { Controller, Get, Query } from '@nestjs/common';
import { EventLogRepository, ReceivedEventView } from './event-log.repository';

/**
 * Read side of the raw event log (DECISIONS.md, section 11), for debugging and the demo:
 *  GET /events?reservationId=r01 -> { events, truncated }: that reservation's newest deliveries
 *  (up to EVENT_LOG_READ_LIMIT) in received order; truncated = older ones were left out.
 * Not gated, like GET /reservations and GET /outbox; bodies hold guest PII, so in production all
 * read routes go behind auth (section 9).
 */
@Controller('events')
export class EventsController {
  constructor(private readonly log: EventLogRepository) {}

  @Get()
  list(@Query('reservationId') reservationId?: string): Promise<{ events: ReceivedEventView[]; truncated: boolean }> {
    return this.log.list(reservationId || undefined);
  }
}
