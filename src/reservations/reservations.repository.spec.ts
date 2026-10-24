import { Db } from '../db/db';
import { createPgliteDb } from '../db/pglite-db';
import { ReservationEvent, ReservationStatus } from '../events/reservation-event';
import { ReservationsRepository } from './reservations.repository';

const event = (eventId: string, occurredAt: string, status: ReservationStatus = 'pending'): ReservationEvent => ({
  eventId,
  type: 'reservation.updated',
  reservationId: 'r1',
  occurredAt,
  data: {
    status,
    guest: { name: 'Ada', email: 'ada@example.com' },
    checkIn: '2026-03-01',
    checkOut: '2026-03-04',
    roomType: 'double',
  },
});

describe('ReservationsRepository (PGlite)', () => {
  let db: Db;
  let repo: ReservationsRepository;
  const outbox = () => db.query<{ key: string; payload: { to: string } }>(`SELECT key, payload FROM outbox`);

  // One database for the file (PGlite boot takes seconds), emptied before each test.
  beforeAll(async () => {
    db = await createPgliteDb();
    repo = new ReservationsRepository(db);
  });
  beforeEach(() => db.query(`TRUNCATE reservations, outbox`));
  afterAll(() => db.close());

  it('creates the record from the first event, whatever its type', async () => {
    expect(await repo.apply(event('e1', '2026-01-01T10:00:00+02:00'))).toEqual({ outcome: 'applied', tie: false });
    expect(await repo.findOne('r1')).toEqual({
      ...event('e1', '').data,
      reservationId: 'r1',
      occurredAt: '2026-01-01T08:00:00.000Z',
      lastEventId: 'e1',
    });
  });

  it('applies newer events and ignores duplicates and stale ones', async () => {
    await repo.apply(event('e1', '2026-01-01T10:00:00Z'));
    expect((await repo.apply(event('e2', '2026-01-01T11:00:00Z', 'cancelled'))).outcome).toBe('applied');
    expect((await repo.apply(event('e2', '2026-01-01T11:00:00.000Z', 'cancelled'))).outcome).toBe('duplicate');
    expect((await repo.apply(event('e1', '2026-01-01T10:00:00Z'))).outcome).toBe('stale');

    expect(await repo.findOne('r1')).toMatchObject({ status: 'cancelled', lastEventId: 'e2' });
  });

  it('reports a timestamp tie with the stored eventId', async () => {
    await repo.apply(event('e-a', '2026-01-01T10:00:00Z'));
    expect(await repo.apply(event('e-b', '2026-01-01T10:00:00Z', 'confirmed'))).toEqual({
      outcome: 'applied',
      tie: true,
      storedEventId: 'e-a',
    });
  });

  it('writes one outbox entry per reservation, even when confirmed again', async () => {
    await repo.apply(event('e1', '2026-01-01T10:00:00Z', 'confirmed'));
    await repo.apply(event('e2', '2026-01-01T11:00:00Z', 'pending'));
    await repo.apply(event('e3', '2026-01-01T12:00:00Z', 'confirmed'));

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'confirmation:r1', payload: { to: 'ada@example.com' } });
  });

  it('writes no outbox entry when the confirmation is stale (cancel already applied)', async () => {
    await repo.apply(event('e2', '2026-01-01T11:00:00Z', 'cancelled'));
    await repo.apply(event('e1', '2026-01-01T10:00:00Z', 'confirmed'));
    expect(await outbox()).toHaveLength(0);
  });

  it('settles concurrent first deliveries of different events to the newest one', async () => {
    const results = await Promise.all([
      repo.apply(event('e1', '2026-01-01T10:00:00Z', 'confirmed')),
      repo.apply(event('e1', '2026-01-01T10:00:00Z', 'confirmed')),
      repo.apply(event('e2', '2026-01-01T11:00:00Z', 'cancelled')),
    ]);
    expect(results.filter((r) => r.outcome === 'applied').length).toBeGreaterThanOrEqual(1);
    expect(await repo.findOne('r1')).toMatchObject({ status: 'cancelled', lastEventId: 'e2' });
    expect(await repo.findAll()).toHaveLength(1);
  });
});
