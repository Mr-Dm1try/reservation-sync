import { createPgliteDb } from './pglite-db';

describe('createPgliteDb', () => {
  it('creates the schema and supports row-value comparison and transactions', async () => {
    const db = await createPgliteDb();
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO reservations_last_event (reservation_id, occurred_at, last_event_id, status, data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['r1', '2026-01-01T10:00:00.000Z', 'e1', 'pending', JSON.stringify({})],
      );
    });

    const [row] = await db.query<{ newer: boolean }>(
      `SELECT (occurred_at, last_event_id) < ($1::timestamptz, $2) AS newer
       FROM reservations_last_event WHERE reservation_id = 'r1'`,
      ['2026-01-01T12:00:00+02:00', 'e0'],
    );
    // Same instant written with a different offset: equal time, so the eventId decides.
    expect(row.newer).toBe(false);

    await expect(
      db.transaction(async (tx) => {
        await tx.query(`DELETE FROM reservations_last_event`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.query(`SELECT 1 FROM reservations_last_event`)).toHaveLength(1);

    await db.close();
  });
});
