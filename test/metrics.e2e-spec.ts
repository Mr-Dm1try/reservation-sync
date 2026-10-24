import request from 'supertest';
import { AppHandle, createApp } from '../src/app';
import { FakeEmailSender } from '../src/email/fake-email-sender';

const event = (eventId: string, occurredAt: string, status: string, reservationId = 'r1') => ({
  eventId,
  type: 'reservation.updated',
  reservationId,
  occurredAt,
  data: {
    status,
    guest: { name: 'Ada', email: 'ada@example.com' },
    checkIn: '2026-03-01',
    checkOut: '2026-03-04',
    roomType: 'double',
  },
});

/** Parses Prometheus text format into { 'name{labels}': value }. */
const parse = (text: string) =>
  Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const at = line.lastIndexOf(' ');
        return [line.slice(0, at), Number(line.slice(at + 1))];
      }),
  );

describe('GET /metrics (e2e)', () => {
  let handle: AppHandle;
  let sender: FakeEmailSender;
  const http = () => request(handle.app.getHttpServer());
  const send = (body: unknown) => http().post('/webhooks/reservations').send(body as object);
  const scrape = async () => {
    const res = await http().get('/metrics').expect(200).expect('Content-Type', /text\/plain/);
    return parse(res.text);
  };

  beforeEach(async () => {
    sender = new FakeEmailSender();
    handle = await createApp({ emailSender: sender, dispatcherIntervalMs: null, logger: false });
  });
  afterEach(() => handle.close());

  it('starts every series at 0', async () => {
    expect(await scrape()).toMatchObject({
      'reservation_events_total{outcome="applied"}': 0,
      'reservation_events_total{outcome="error"}': 0,
      reservation_event_timestamp_tie_total: 0,
      'outbox_send_total{result="sent"}': 0,
      'outbox_entries{status="pending"}': 0,
      outbox_oldest_pending_age_seconds: 0,
    });
  });

  it('counts webhook outcomes, the tie alert and outbox results', async () => {
    await send(event('e2', '2026-01-01T11:00:00Z', 'confirmed')).expect(200, { outcome: 'applied' });
    await send(event('e2', '2026-01-01T11:00:00Z', 'confirmed')).expect(200, { outcome: 'duplicate' });
    await send(event('e1', '2026-01-01T10:00:00Z', 'pending')).expect(200, { outcome: 'stale' });
    await send(event('e3', '2026-01-01T11:00:00Z', 'confirmed')).expect(200, { outcome: 'applied' }); // tie
    await send({ eventId: 'x' }).expect(400);
    await send({ ...event('e9', '2026-01-01T10:00:00Z', 'pending'), type: 'reservation.merged' }).expect(200);
    // r2: confirmed, then cancelled before the dispatcher runs -> skipped
    await send(event('f1', '2026-01-01T10:00:00Z', 'confirmed', 'r2')).expect(200);
    await send(event('f2', '2026-01-01T11:00:00Z', 'cancelled', 'r2')).expect(200);

    expect(await scrape()).toMatchObject({ 'outbox_entries{status="pending"}': 2 });

    sender.failNext(1);
    await handle.dispatcher.drainUntilIdle();

    expect(await scrape()).toMatchObject({
      'reservation_events_total{outcome="applied"}': 4,
      'reservation_events_total{outcome="duplicate"}': 1,
      'reservation_events_total{outcome="stale"}': 1,
      'reservation_events_total{outcome="ignored"}': 1,
      'reservation_events_total{outcome="rejected"}': 1,
      'reservation_events_total{outcome="error"}': 0,
      reservation_event_timestamp_tie_total: 1,
      'outbox_send_total{result="sent"}': 1,
      'outbox_send_total{result="failed"}': 1,
      'outbox_send_total{result="skipped"}': 1,
      'outbox_entries{status="pending"}': 0,
      'outbox_entries{status="sent"}': 1,
      'outbox_entries{status="skipped"}': 1,
      outbox_oldest_pending_age_seconds: 0,
    });
  });

  it('counts internal errors (the source will retry)', async () => {
    await handle.db.query(`DROP TABLE reservations_last_event CASCADE`);
    await send(event('e1', '2026-01-01T10:00:00Z', 'pending')).expect(500);
    expect((await scrape())['reservation_events_total{outcome="error"}']).toBe(1);
  });
});
