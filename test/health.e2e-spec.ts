import request from 'supertest';
import { createApp, AppHandle } from '../src/app';

describe('app boot', () => {
  let handle: AppHandle;

  beforeAll(async () => {
    handle = await createApp({ dispatcherIntervalMs: null, logger: false });
  });
  afterAll(() => handle.close());

  it('serves /health and /debug/emails', async () => {
    await request(handle.app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
    const res = await request(handle.app.getHttpServer()).get('/debug/emails').expect(200);
    expect(res.body.delivered).toEqual([]);
  });
});
