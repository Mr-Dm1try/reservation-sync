import { EmailMessage, EmailSender, TransientEmailError } from './email-sender';

/**
 * Simulated email provider. Behaves like a real one in the ways that matter here:
 *  - it can fail transiently (`failNext`), so the dispatcher's retries get exercised;
 *  - it honours idempotency keys: a repeated key is accepted but not delivered again.
 * Tests assert on `delivered` (what guests actually got) and on `suppressedDuplicates`
 * (should stay 0: the app must not rely on the provider to dedupe in normal operation).
 */
export class FakeEmailSender implements EmailSender {
  readonly delivered: EmailMessage[] = [];
  attempts = 0;
  suppressedDuplicates = 0;

  private readonly seenKeys = new Set<string>();
  private failuresLeft = 0;

  failNext(count: number): void {
    this.failuresLeft += count;
  }

  async send(message: EmailMessage): Promise<void> {
    this.attempts++;
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new TransientEmailError();
    }
    if (this.seenKeys.has(message.idempotencyKey)) {
      this.suppressedDuplicates++;
      return;
    }
    this.seenKeys.add(message.idempotencyKey);
    this.delivered.push(message);
  }

  deliveredFor(reservationId: string): EmailMessage[] {
    return this.delivered.filter((m) => m.reservationId === reservationId);
  }
}
