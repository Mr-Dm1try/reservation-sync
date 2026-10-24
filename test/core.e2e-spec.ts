import request from 'supertest';
import { AppHandle, createApp } from '../src/app';
import { FakeEmailSender } from '../src/email/fake-email-sender';

const event = (eventId: string, occurredAt: string, status: string, extra: object = {}) => ({
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
  ...extra,
});

describe('core sync (e2e)', () => {
  let handle: AppHandle;
  let sender: FakeEmailSender;
  const http = () => request(handle.app.getHttpServer());
  const send = (body: unknown) => http().post('/webhooks/reservations').send(body as object);

  beforeEach(async () => {
    sender = new FakeEmailSender();
    handle = await createApp({ emailSender: sender, dispatcherIntervalMs: null, logger: false });
  });
  afterEach(() => handle.close());

  it('out of order, duplicated and concurrent deliveries end in the newest state with one email', async () => {
    const created = event('e1', '2026-01-01T10:00:00Z', 'pending', { type: 'reservation.created' });
    const confirmed = event('e2', '2026-01-01T11:00:00Z', 'confirmed');
    const updated = event('e3', '2026-01-01T14:00:00+02:00', 'confirmed', { data: { ...confirmed.data, roomType: 'suite' } });

    // Update before create, a burst of concurrent redeliveries, then a very late replay.
    await send(confirmed).expect(200, { outcome: 'applied' });
    const burst = await Promise.all([send(confirmed), send(confirmed), send(updated), send(updated)]);
    expect(burst.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    await send(created).expect(200, { outcome: 'stale' });
    await send(updated).expect(200, { outcome: 'duplicate' });

    await handle.dispatcher.drainUntilIdle();

    await http()
      .get('/reservations/r1')
      .expect(200)
      .expect((res) =>
        expect(res.body).toMatchObject({
          reservationId: 'r1',
          status: 'confirmed',
          roomType: 'suite',
          lastEventId: 'e3',
          occurredAt: '2026-01-01T12:00:00.000Z',
        }),
      );
    expect(sender.deliveredFor('r1')).toHaveLength(1);
    expect(sender.suppressedDuplicates).toBe(0);
    const outbox = await http().get('/outbox').expect(200);
    expect(outbox.body).toMatchObject([{ key: 'confirmation:r1', status: 'sent' }]);
  });

  it('bulk retry of dead-lettered emails validates failedSince', async () => {
    await http().post('/outbox/retry-failed?failedSince=yesterday').expect(400);
    await http().post('/outbox/retry-failed?failedSince=2026-01-01T00:00:00Z').expect(200, { requeued: 0, keys: [] });
    await http().post('/outbox/retry-failed').expect(200, { requeued: 0, keys: [] });
  });

  it('a late confirmation after a cancel changes nothing and sends no email', async () => {
    await send(event('e2', '2026-01-01T11:00:00Z', 'cancelled')).expect(200, { outcome: 'applied' });
    await send(event('e1', '2026-01-01T10:00:00Z', 'confirmed')).expect(200, { outcome: 'stale' });
    await handle.dispatcher.drainUntilIdle();

    await http().get('/reservations/r1').expect(200).expect((res) => expect(res.body.status).toBe('cancelled'));
    expect(sender.delivered).toHaveLength(0);
  });

  it('rejects malformed events, ignores unknown types, alerts on timestamp ties', async () => {
    const bad = await send({ ...event('e1', '2026-01-01T10:00:00Z', 'pending'), data: { status: 'pending' } }).expect(400);
    expect(bad.body.issues.length).toBeGreaterThan(0);
    await send({ eventId: 'x' }).expect(400);
    await send({ ...event('e9', '2026-01-01T10:00:00Z', 'pending'), type: 'reservation.merged' }).expect(200, {
      outcome: 'ignored',
    });
    await http().get('/reservations').expect(200, []);
    await http().get('/reservations/r1').expect(404);

    await send(event('e-a', '2026-01-01T10:00:00Z', 'pending')).expect(200, { outcome: 'applied' });
    await send(event('e-b', '2026-01-01T10:00:00.000Z', 'pending')).expect(200, { outcome: 'applied' });
    expect(handle.alerts.counts.timestampTie).toBe(1);
  });
});
