import request from 'supertest';
import { AppHandle, createApp } from '../src/app';
import { Db } from '../src/db/db';
import { FakeEmailSender } from '../src/email/fake-email-sender';
import { createTestDb, testDbKind } from './test-db';

jest.setTimeout(30_000);

const N = 50;

const event = (reservationId: string, eventId: string, occurredAt: string, status: string, type = 'reservation.updated') => ({
  eventId,
  type,
  reservationId,
  occurredAt,
  data: {
    status,
    guest: { name: 'Ada', email: `${reservationId}@example.com` },
    checkIn: '2026-03-01',
    checkOut: '2026-03-04',
    roomType: 'double',
  },
});

/**
 * Two app instances on one database, like two pods. On PGlite (one connection) this passes
 * trivially because transactions run one at a time; on Postgres (`npm run test:pg`) every request
 * gets its own pooled connection, so the first-insert race, the row lock and the SKIP LOCKED claim
 * are exercised for real (DECISIONS.md, section 5).
 */
describe(`two instances, one database (${testDbKind})`, () => {
  let db: Db;
  let a: AppHandle;
  let b: AppHandle;
  const sender = new FakeEmailSender();

  beforeAll(async () => {
    db = await createTestDb();
    a = await createApp({ db, emailSender: sender, dispatcherIntervalMs: null, logger: false });
    b = await createApp({ db, emailSender: sender, dispatcherIntervalMs: null, logger: false });
  });
  afterAll(async () => {
    await a.app.close();
    await b.app.close();
    await db.close();
  });

  it('concurrent first events, redeliveries and out-of-order updates end in the newest state', async () => {
    // Per reservation: the create plus four newer confirmations, shuffled and partly redelivered.
    // Each event must win or lose against whatever committed first, so a missing row lock shows up
    // as a lost update (an older confirmation written over a newer one).
    const deliveries = Array.from({ length: N }, (_, i) => {
      const r = `r${i}`;
      const e = (n: number) =>
        n === 1
          ? event(r, `${r}-e1`, '2026-01-01T10:00:00Z', 'pending', 'reservation.created')
          : event(r, `${r}-e${n}`, `2026-01-01T1${n}:00:00Z`, 'confirmed');
      return [2, 4, 1, 3, 5, 4, 2].map(e);
    }).flat();

    const results = await Promise.all(
      deliveries.map((body, i) =>
        request((i % 2 ? a : b).app.getHttpServer())
          .post('/webhooks/reservations')
          .send(body),
      ),
    );
    expect(results.filter((r) => r.status !== 200)).toEqual([]);

    const rows = await db.query<{ last_event_id: string; status: string }>(
      `SELECT last_event_id, status FROM reservations_last_event ORDER BY reservation_id`,
    );
    expect(rows).toHaveLength(N);
    expect(rows.filter((r) => !r.last_event_id.endsWith('-e5') || r.status !== 'confirmed')).toEqual([]);
    const [outbox] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending'`);
    expect(outbox.n).toBe(N);

    // The raw event log (DECISIONS.md, section 11) has one row per delivery, and each event is
    // applied at most once, however its redeliveries interleave.
    const [log] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM events_received`);
    expect(log.n).toBe(deliveries.length);
    const appliedTwice = await db.query(
      `SELECT event_id FROM events_received WHERE outcome = 'applied' GROUP BY event_id HAVING count(*) > 1`,
    );
    expect(appliedTwice).toEqual([]);
  });

  it('two dispatchers draining at once send each email exactly once', async () => {
    // drainOnce, not drainUntilIdle: the latter ignores leases, which is only safe for one instance.
    const drain = async (h: AppHandle) => {
      while ((await h.dispatcher.drainOnce()) > 0);
    };
    await Promise.all([drain(a), drain(b), drain(a), drain(b)]);

    expect(sender.delivered).toHaveLength(N);
    expect(sender.suppressedDuplicates).toBe(0);
    const [sent] = await db.query<{ n: number; max_attempts: number }>(
      `SELECT count(*)::int AS n, max(attempts) AS max_attempts FROM outbox WHERE status = 'sent'`,
    );
    expect(sent).toEqual({ n: N, max_attempts: 1 });
  });
});
