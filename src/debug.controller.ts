import { Controller, Get, Inject, NotFoundException } from '@nestjs/common';
import { EMAIL_SENDER, EmailSender } from './email/email-sender';
import { FakeEmailSender } from './email/fake-email-sender';

/** Test/demo only: exposes what the fake provider delivered. Not registered in production. */
@Controller('debug')
export class DebugController {
  constructor(@Inject(EMAIL_SENDER) private readonly sender: EmailSender) {}

  @Get('emails')
  emails() {
    if (!(this.sender instanceof FakeEmailSender)) throw new NotFoundException();
    return {
      delivered: this.sender.delivered,
      attempts: this.sender.attempts,
      suppressedDuplicates: this.sender.suppressedDuplicates,
    };
  }
}
