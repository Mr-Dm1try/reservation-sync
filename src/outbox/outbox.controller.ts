import { Controller, Get } from '@nestjs/common';
import { OutboxEntryView, OutboxRepository } from './outbox.repository';

/** Read side for the demo and tests (DECISIONS.md, section 6). Payload left out: it holds guest PII. */
@Controller('outbox')
export class OutboxController {
  constructor(private readonly outbox: OutboxRepository) {}

  @Get()
  list(): Promise<OutboxEntryView[]> {
    return this.outbox.list();
  }
}
