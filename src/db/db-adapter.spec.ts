import { createTestDb, testDbKind } from '../../test/test-db';

// Runs on both drivers: the repositories rely on these shapes, so the adapters must agree.
describe(`Db adapter type parity (${testDbKind})`, () => {
  it('returns timestamptz as Date, jsonb parsed, int as number, and rolls back on throw', async () => {
    const db = await createTestDb();
    try {
      await db.query(
        `INSERT INTO reservations_last_event (reservation_id, occurred_at, last_event_id, status, data)
         VALUES ($1, $2, $3, $4, $5)`,
        ['r1', '2026-01-01T12:00:00+02:00', 'e1', 'pending', JSON.stringify({ guest: { name: 'Ada' } })],
      );
      const [row] = await db.query<{ occurred_at: unknown; data: unknown; n: unknown }>(
        `SELECT occurred_at, data, (SELECT count(*)::int FROM reservations_last_event) AS n FROM reservations_last_event`,
      );
      expect(row.occurred_at).toEqual(new Date('2026-01-01T10:00:00.000Z'));
      expect(row.data).toEqual({ guest: { name: 'Ada' } });
      expect(row.n).toBe(1);

      await expect(
        db.transaction(async (tx) => {
          await tx.query(`DELETE FROM reservations_last_event`);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await db.query(`SELECT 1 FROM reservations_last_event`)).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
