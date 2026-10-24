import { Logger } from '@nestjs/common';
import { Db } from '../db/db';
import { createPgliteDb } from '../db/pglite-db';
import { FakeEmailSender } from '../email/fake-email-sender';
import { OutboxDispatcher } from './outbox-dispatcher';

describe('OutboxDispatcher (PGlite)', () => {
  let db: Db;
  let sender: FakeEmailSender;
  let dispatcher: OutboxDispatcher;

  const enqueue = (reservationId: string) =>
    db.query(
      `INSERT INTO outbox (key, reservation_id, kind, payload) VALUES ($1, $2, 'confirmation_email', $3)`,
      [`confirmation:${reservationId}`, reservationId, JSON.stringify({ to: 'a@b.c', subject: 's', body: 'b' })],
    );
  const row = async (key: string) =>
    (
      await db.query<{ status: string; attempts: number; last_error: string | null; due: boolean }>(
        `SELECT status, attempts, last_error, next_attempt_at <= now() AS due FROM outbox WHERE key = $1`,
        [key],
      )
    )[0];

  beforeAll(async () => {
    Logger.overrideLogger(false); // the failure paths log a warning per attempt
    db = await createPgliteDb();
  });
  beforeEach(async () => {
    await db.query(`TRUNCATE outbox`);
    sender = new FakeEmailSender();
    dispatcher = new OutboxDispatcher(db, sender, null);
  });
  afterAll(() => db.close());

  it('sends due entries with the outbox key as idempotency key and marks them sent', async () => {
    await enqueue('r1');
    expect(await dispatcher.drainOnce()).toBe(1);

    expect(sender.delivered).toEqual([
      { idempotencyKey: 'confirmation:r1', reservationId: 'r1', to: 'a@b.c', subject: 's', body: 'b' },
    ]);
    expect(await row('confirmation:r1')).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await dispatcher.drainOnce()).toBe(0);
  });

  it('on failure records the error and backs off; the entry is not due again right away', async () => {
    await enqueue('r1');
    sender.failNext(1);

    expect(await dispatcher.drainOnce()).toBe(1);
    expect(await row('confirmation:r1')).toMatchObject({ status: 'pending', attempts: 1, due: false });
    expect((await row('confirmation:r1')).last_error).toMatch(/transient/i);
    expect(await dispatcher.drainOnce()).toBe(0);

    await dispatcher.drainUntilIdle();
    expect(sender.delivered).toHaveLength(1);
    expect(await row('confirmation:r1')).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
  });

  it('drainUntilIdle drains more than one batch and survives repeated failures', async () => {
    for (let i = 0; i < 45; i++) await enqueue(`r${i}`);
    sender.failNext(30);

    await dispatcher.drainUntilIdle();
    expect(sender.delivered).toHaveLength(45);
    expect(sender.suppressedDuplicates).toBe(0);
  });

  it('drainUntilIdle throws when entries are still pending after maxRounds', async () => {
    await enqueue('r1');
    sender.failNext(5);
    await expect(dispatcher.drainUntilIdle(3)).rejects.toThrow(/not idle after 3 rounds: 1/);
  });
});
