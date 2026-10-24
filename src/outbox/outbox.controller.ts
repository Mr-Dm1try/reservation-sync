import { BadRequestException, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { OutboxEntryView, OutboxRepository } from './outbox.repository';

/** Read side for the demo and tests (DECISIONS.md, section 6). Payload left out: it holds guest PII. */
@Controller('outbox')
export class OutboxController {
  constructor(private readonly outbox: OutboxRepository) {}

  @Get()
  list(): Promise<OutboxEntryView[]> {
    return this.outbox.list();
  }

  /**
   * Operator action after an outage is fixed: requeue every dead-lettered entry (optionally only
   * those that failed since `failedSince`, ISO-8601). No auth in this exercise; in production this
   * sits behind internal auth, not on the public ingress.
   */
  @Post('retry-failed')
  @HttpCode(200)
  async retryFailed(@Query('failedSince') failedSince?: string): Promise<{ requeued: number; keys: string[] }> {
    if (failedSince !== undefined && !z.iso.datetime({ offset: true }).safeParse(failedSince).success) {
      throw new BadRequestException('failedSince must be an ISO-8601 date-time');
    }
    const keys = await this.outbox.retryFailed({ failedSince });
    return { requeued: keys.length, keys };
  }
}
