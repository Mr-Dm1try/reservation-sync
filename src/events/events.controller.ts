import { Controller, Get, Query } from '@nestjs/common';
import { EventLogRepository, ReceivedEventView } from './event-log.repository';

/**
 * Read side of the raw event log (DECISIONS.md, section 11), for debugging and the demo:
 *  GET /events?reservationId=r01 -> that reservation's deliveries in received order.
 * Not gated, like GET /reservations and GET /outbox; bodies hold guest PII, so in production all
 * read routes go behind auth (section 9).
 */
@Controller('events')
export class EventsController {
  constructor(private readonly log: EventLogRepository) {}

  @Get()
  list(@Query('reservationId') reservationId?: string): Promise<ReceivedEventView[]> {
    return this.log.list(reservationId || undefined);
  }
}
