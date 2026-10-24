import request from 'supertest';
import { AppHandle, createApp } from '../src/app';
import { Db } from '../src/db/db';
import { FakeEmailSender } from '../src/email/fake-email-sender';
import type { ReservationView } from '../src/reservations/reservation-view';

export type SendResult = { status: number; body: any };

export type EmailReport = {
  delivered: { reservationId: string; idempotencyKey: string }[];
  suppressedDuplicates: number;
  pendingOutbox: number;
};

/** What the runner needs from "the app", whether it runs in-process or behind a URL. */
export interface Target {
  send(body: unknown): Promise<SendResult>;
  failNextEmails(count: number): Promise<void>;
  /** The operator's bulk retry of dead-lettered outbox entries. */
  retryFailedEmails(): Promise<{ requeued: number }>;
  /** Lets background work finish: drains the outbox until idle. */
  settle(): Promise<void>;
  reservations(): Promise<ReservationView[]>;
  emails(): Promise<EmailReport>;
  alerts(): Promise<{ timestampTie: number; outboxDeadLettered: number }>;
  close(): Promise<void>;
}

async function pendingOutbox(handle: AppHandle): Promise<number> {
  const [row] = await handle.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending'`);
  return row.n;
}

/**
 * Fresh app per scenario, driven over real HTTP via supertest. Booting PGlite takes seconds, so
 * a test file can pass one shared `db`: its tables are emptied first, and it is left open on close.
 */
export async function inProcessTarget(options: { db?: Db; outboxRetryWindowMs?: number } = {}): Promise<Target> {
  if (options.db) await options.db.query(`TRUNCATE reservations_last_event, outbox`);
  const emailSender = new FakeEmailSender();
  const handle = await createApp({
    db: options.db,
    emailSender,
    dispatcherIntervalMs: null,
    outboxRetryWindowMs: options.outboxRetryWindowMs,
    logger: false,
  });
  const http = handle.app.getHttpServer();

  return {
    async send(body) {
      const res = await request(http).post('/webhooks/reservations').send(body as object);
      return { status: res.status, body: res.body };
    },
    async failNextEmails(count) {
      emailSender.failNext(count);
    },
    async retryFailedEmails() {
      const res = await request(http).post('/outbox/retry-failed');
      if (res.status !== 200) throw new Error(`POST /outbox/retry-failed -> ${res.status}`);
      return res.body;
    },
    settle: () => handle.dispatcher.drainUntilIdle(),
    async reservations() {
      const res = await request(http).get('/reservations');
      if (res.status !== 200) throw new Error(`GET /reservations -> ${res.status}`);
      return res.body;
    },
    async emails() {
      return {
        delivered: emailSender.delivered,
        suppressedDuplicates: emailSender.suppressedDuplicates,
        pendingOutbox: await pendingOutbox(handle),
      };
    },
    async alerts() {
      return { ...handle.alerts.counts };
    },
    close: () => (options.db ? handle.app.close() : handle.close()),
  };
}

/**
 * A running server (`npm run start:debug`, which sets DEBUG_ENDPOINTS=1 for the /debug routes).
 * Settling waits for the server's own background dispatcher to empty the outbox, rather than
 * draining it from outside, which could race the dispatcher's in-flight sends. State is NOT reset between scenarios: the CLI runs one scenario per
 * fresh server, or relies on scenario reservation ids being unique.
 */
export function httpTarget(baseUrl: string): Target {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await call(method, path, body);
    if (res.status >= 300) throw new Error(`${method} ${path} -> ${res.status}`);
    return res.body;
  };

  return {
    send: (body) => call('POST', '/webhooks/reservations', body),
    failNextEmails: async (count) => void (await ok('POST', '/debug/email-failures', { count })),
    retryFailedEmails: () => ok('POST', '/outbox/retry-failed'),
    async settle(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while ((await ok('GET', '/debug/emails')).pendingOutbox > 0) {
        if (Date.now() > deadline) throw new Error(`outbox still pending after ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, 200));
      }
    },
    reservations: () => ok('GET', '/reservations'),
    emails: () => ok('GET', '/debug/emails'),
    alerts: () => ok('GET', '/debug/alerts'),
    close: async () => undefined,
  };
}
