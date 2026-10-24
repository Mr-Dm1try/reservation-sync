import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ReservationView } from './reservation-view';
import { ReservationsRepository } from './reservations.repository';
import { ReservationsService, WebhookOutcome } from './reservations.service';

/**
 * API contract (DECISIONS.md, section 6):
 *  POST /webhooks/reservations  -> 200 { outcome } for applied | duplicate | stale | ignored,
 *                                  400 for malformed, 500 on internal error (source retries).
 *  GET  /reservations           -> ReservationView[]
 *  GET  /reservations/:id       -> ReservationView, or 404
 */
@Controller()
export class ReservationsController {
  constructor(
    private readonly service: ReservationsService,
    private readonly repo: ReservationsRepository,
  ) {}

  @Post('webhooks/reservations')
  @HttpCode(200)
  receive(@Body() body: unknown): Promise<{ outcome: WebhookOutcome }> {
    return this.service.receive(body);
  }

  @Get('reservations')
  list(): Promise<ReservationView[]> {
    return this.repo.findAll();
  }

  @Get('reservations/:id')
  async get(@Param('id') id: string): Promise<ReservationView> {
    const view = await this.repo.findOne(id);
    if (!view) throw new NotFoundException(`Reservation ${id} not found`);
    return view;
  }
}
