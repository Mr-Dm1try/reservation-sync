import { TransientEmailError } from './email-sender';
import { FakeEmailSender } from './fake-email-sender';

const msg = { idempotencyKey: 'confirmation:r1', reservationId: 'r1', to: 'a@b.c', subject: 's', body: 'b' };

describe('FakeEmailSender', () => {
  it('fails the requested number of times, then delivers once per idempotency key', async () => {
    const sender = new FakeEmailSender();
    sender.failNext(2);

    await expect(sender.send(msg)).rejects.toBeInstanceOf(TransientEmailError);
    await expect(sender.send(msg)).rejects.toBeInstanceOf(TransientEmailError);
    await sender.send(msg);
    await sender.send(msg);

    expect(sender.attempts).toBe(4);
    expect(sender.delivered).toHaveLength(1);
    expect(sender.suppressedDuplicates).toBe(1);
  });
});
