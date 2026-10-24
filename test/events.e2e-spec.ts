import request from 'supertest';
import { history } from '../simulator/events';
import { AppHandle, createApp } from '../src/app';
import { createTestDb } from './test-db';

describe('GET /events (e2e)', () => {
  let handle: AppHandle;
  const http = () => request(handle.app.getHttpServer());
  const send = (body: unknown) => http().post('/webhooks/reservations').send(body as object);

  beforeAll(async () => {
    handle = await createApp({ db: await createTestDb(), dispatcherIntervalMs: null, logger: false });
  });
  afterAll(() => handle.close());

  it("tells one reservation's delivery story in received order", async () => {
    const r = history('r01');
    const created = r.next('reservation.created');
    const confirmed = r.next('reservation.updated', { status: 'confirmed' });
    for (const body of [created, confirmed, created, confirmed]) await send(body).expect(200);
    await send(history('r02').next('reservation.created')).expect(200);
    await send({ ...created, data: {} }).expect(400);

    const res = await http().get('/events').query({ reservationId: 'r01' }).expect(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.events.map((e: { eventId: string; outcome: string }) => [e.eventId, e.outcome])).toEqual([
      ['r01-e1', 'applied'],
      ['r01-e2', 'applied'],
      ['r01-e1', 'stale'],
      ['r01-e2', 'duplicate'],
      ['r01-e1', 'rejected'],
    ]);
    expect(res.body.events[1]).toMatchObject({ reservationId: 'r01', type: 'reservation.updated', body: confirmed });

    const all = await http().get('/events').expect(200);
    expect(all.body.events).toHaveLength(6);
    expect(all.body.events.map((e: { id: number }) => e.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
