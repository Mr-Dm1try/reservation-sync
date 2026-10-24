import 'reflect-metadata';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DB, Db } from './db/db';
import { createPgliteDb } from './db/pglite-db';
import { DebugController } from './debug.controller';
import { EMAIL_SENDER, EmailSender } from './email/email-sender';
import { FakeEmailSender } from './email/fake-email-sender';
import { HealthController } from './health.controller';
import { Alerts } from './observability/alerts';
import { DISPATCHER_INTERVAL_MS, OutboxDispatcher } from './outbox/outbox-dispatcher';
import { ReservationsController } from './reservations/reservations.controller';

export type CreateAppOptions = {
  db?: Db;
  emailSender?: EmailSender;
  /** null = no background polling; tests call dispatcher.drainUntilIdle() instead. */
  dispatcherIntervalMs?: number | null;
  /** Registers GET /debug/emails. Defaults to NODE_ENV !== 'production'. */
  debugEndpoints?: boolean;
  logger?: false | ('error' | 'warn' | 'log')[];
};

export type AppHandle = {
  app: INestApplication;
  db: Db;
  emailSender: EmailSender;
  alerts: Alerts;
  dispatcher: OutboxDispatcher;
  close(): Promise<void>;
};

/** Single composition root, used by main.ts, the e2e tests and the simulator. */
export async function createApp(options: CreateAppOptions = {}): Promise<AppHandle> {
  const db = options.db ?? (await createPgliteDb());
  const emailSender = options.emailSender ?? new FakeEmailSender();
  const debug = options.debugEndpoints ?? process.env.NODE_ENV !== 'production';

  @Module({
    controllers: [HealthController, ReservationsController, ...(debug ? [DebugController] : [])],
    providers: [
      { provide: DB, useValue: db },
      { provide: EMAIL_SENDER, useValue: emailSender },
      { provide: DISPATCHER_INTERVAL_MS, useValue: options.dispatcherIntervalMs ?? 500 },
      Alerts,
      OutboxDispatcher,
    ],
  })
  class AppModule {}

  const app = await NestFactory.create(AppModule, { logger: options.logger ?? ['error', 'warn', 'log'] });
  await app.init();

  const dispatcher = app.get(OutboxDispatcher);
  dispatcher.start();

  return {
    app,
    db,
    emailSender,
    alerts: app.get(Alerts),
    dispatcher,
    async close() {
      await app.close();
      await db.close();
    },
  };
}
