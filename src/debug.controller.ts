import { Body, Controller, Get, HttpCode, Inject, NotFoundException, Post } from '@nestjs/common';
import { DB, Db } from './db/db';
import { EMAIL_SENDER, EmailSender } from './email/email-sender';
import { FakeEmailSender } from './email/fake-email-sender';
import { Alerts } from './observability/alerts';

/**
 * Test/demo only: lets the simulator CLI inspect and drive a running server.
 * Only registered with DEBUG_ENDPOINTS=1 (see createApp).
 */
@Controller('debug')
export class DebugController {
  constructor(
    @Inject(EMAIL_SENDER) private readonly sender: EmailSender,
    @Inject(DB) private readonly db: Db,
    private readonly alerts: Alerts,
  ) {}

  private fake(): FakeEmailSender {
    if (!(this.sender instanceof FakeEmailSender)) throw new NotFoundException('Not using the fake email sender');
    return this.sender;
  }

  @Get('emails')
  async emails() {
    const sender = this.fake();
    const [row] = await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending'`);
    return {
      delivered: sender.delivered,
      attempts: sender.attempts,
      suppressedDuplicates: sender.suppressedDuplicates,
      pendingOutbox: row.n,
    };
  }

  @Post('email-failures')
  @HttpCode(204)
  failNext(@Body() body: { count: number }) {
    this.fake().failNext(Number(body.count));
  }

  @Get('alerts')
  alertCounts() {
    return this.alerts.counts;
  }
}
