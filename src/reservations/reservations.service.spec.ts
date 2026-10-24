import { Db } from '../db/db';
import { createPgliteDb } from '../db/pglite-db';
import { ReservationEvent, ReservationStatus } from '../events/reservation-event';
import { Alerts } from '../observability/alerts';
import { OutboxRepository } from '../outbox/outbox.repository';
import { ReservationsRepository } from './reservations.repository';
import { ReservationsService } from './reservations.service';

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

describe('ReservationsService.apply (PGlite)', () => {
  let db: Db;
  let repo: ReservationsRepository;
  let service: ReservationsService;
  const outbox = () => db.query<{ key: string; payload: { to: string } }>(`SELECT key, payload FROM outbox`);

  // One database for the file (PGlite boot takes seconds), emptied before each test.
  beforeAll(async () => {
    db = await createPgliteDb();
    repo = new ReservationsRepository(db);
    service = new ReservationsService(db, repo, new OutboxRepository(db), new Alerts());
  });
  beforeEach(() => db.query(`TRUNCATE reservations_last_event, outbox`));
  afterAll(() => db.close());

  it('creates the record from the first event, whatever its type', async () => {
    expect(await service.apply(event('e1', '2026-01-01T10:00:00+02:00'))).toEqual({ outcome: 'applied', tie: false });
    expect(await repo.findOne('r1')).toEqual({
      ...event('e1', '').data,
      reservationId: 'r1',
      occurredAt: '2026-01-01T08:00:00.000Z',
      lastEventId: 'e1',
    });
  });

  it('applies newer events and ignores duplicates and stale ones', async () => {
    await service.apply(event('e1', '2026-01-01T10:00:00Z'));
    expect((await service.apply(event('e2', '2026-01-01T11:00:00Z', 'cancelled'))).outcome).toBe('applied');
    expect((await service.apply(event('e2', '2026-01-01T11:00:00.000Z', 'cancelled'))).outcome).toBe('duplicate');
    expect((await service.apply(event('e1', '2026-01-01T10:00:00Z'))).outcome).toBe('stale');

    expect(await repo.findOne('r1')).toMatchObject({ status: 'cancelled', lastEventId: 'e2' });
  });

  it('reports a timestamp tie with the stored eventId', async () => {
    await service.apply(event('e-a', '2026-01-01T10:00:00Z'));
    expect(await service.apply(event('e-b', '2026-01-01T10:00:00Z', 'confirmed'))).toEqual({
      outcome: 'applied',
      tie: true,
      storedEventId: 'e-a',
    });
  });

  it('writes one outbox entry per reservation, even when confirmed again', async () => {
    await service.apply(event('e1', '2026-01-01T10:00:00Z', 'confirmed'));
    await service.apply(event('e2', '2026-01-01T11:00:00Z', 'pending'));
    await service.apply(event('e3', '2026-01-01T12:00:00Z', 'confirmed'));

    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'confirmation:r1', payload: { to: 'ada@example.com' } });
  });

  it('revives a skipped entry when the reservation is confirmed again, but never a sent one', async () => {
    await service.apply(event('e1', '2026-01-01T10:00:00Z', 'confirmed'));
    await service.apply(event('e2', '2026-01-01T11:00:00Z', 'cancelled'));
    await db.query(`UPDATE outbox SET status = 'skipped'`); // what the dispatcher does on a cancel
    await service.apply(event('e3', '2026-01-01T12:00:00Z', 'confirmed'));
    expect(await db.query(`SELECT status FROM outbox`)).toEqual([{ status: 'pending' }]);

    await db.query(`UPDATE outbox SET status = 'sent'`);
    await service.apply(event('e4', '2026-01-01T13:00:00Z', 'confirmed'));
    expect(await db.query(`SELECT status FROM outbox`)).toEqual([{ status: 'sent' }]);
  });

  it('writes no outbox entry when the confirmation is stale (cancel already applied)', async () => {
    await service.apply(event('e2', '2026-01-01T11:00:00Z', 'cancelled'));
    await service.apply(event('e1', '2026-01-01T10:00:00Z', 'confirmed'));
    expect(await outbox()).toHaveLength(0);
  });

  it('settles concurrent first deliveries of different events to the newest one', async () => {
    const results = await Promise.all([
      service.apply(event('e1', '2026-01-01T10:00:00Z', 'confirmed')),
      service.apply(event('e1', '2026-01-01T10:00:00Z', 'confirmed')),
      service.apply(event('e2', '2026-01-01T11:00:00Z', 'cancelled')),
    ]);
    expect(results.filter((r) => r.outcome === 'applied').length).toBeGreaterThanOrEqual(1);
    expect(await repo.findOne('r1')).toMatchObject({ status: 'cancelled', lastEventId: 'e2' });
    expect(await repo.findAll()).toHaveLength(1);
  });
});
