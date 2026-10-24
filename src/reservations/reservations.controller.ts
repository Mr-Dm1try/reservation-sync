import { Body, Controller, Get, HttpCode, NotImplementedException, Param, Post } from '@nestjs/common';
import { ReservationView } from './reservation-view';

/**
 * API contract (DECISIONS.md, section 6):
 *  POST /webhooks/reservations  -> 200 { outcome } for applied | duplicate | stale | ignored,
 *                                  400 for malformed, 500 on internal error (source retries).
 *  GET  /reservations           -> ReservationView[]
 *  GET  /reservations/:id       -> ReservationView, or 404
 * STEP 2 TODO: implement.
 */
@Controller()
export class ReservationsController {
  @Post('webhooks/reservations')
  @HttpCode(200)
  async receive(@Body() body: unknown): Promise<{ outcome: string }> {
    void body;
    throw new NotImplementedException();
  }

  @Get('reservations')
  async list(): Promise<ReservationView[]> {
    throw new NotImplementedException();
  }

  @Get('reservations/:id')
  async get(@Param('id') id: string): Promise<ReservationView> {
    void id;
    throw new NotImplementedException();
  }
}
