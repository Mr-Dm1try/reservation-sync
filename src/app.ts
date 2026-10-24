import 'reflect-metadata';
import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DB, Db } from './db/db';
import { createPgliteDb } from './db/pglite-db';
import { DebugController } from './debug.controller';
import { EMAIL_SENDER, EmailSender } from './email/email-sender';
import { FakeEmailSender } from './email/fake-email-sender';
import { EventLogRepository } from './events/event-log.repository';
import { EventsController } from './events/events.controller';
import { HealthController } from './health.controller';
import { Alerts } from './observability/alerts';
import { Metrics } from './observability/metrics';
import { MetricsController } from './observability/metrics.controller';
import { DISPATCHER_INTERVAL_MS, OutboxDispatcher } from './outbox/outbox-dispatcher';
import { OutboxController } from './outbox/outbox.controller';
import { OutboxRepository } from './outbox/outbox.repository';
import { ReservationsController } from './reservations/reservations.controller';
import { ReservationsRepository } from './reservations/reservations.repository';
import { ReservationsService } from './reservations/reservations.service';

export type CreateAppOptions = {
  db?: Db;
  emailSender?: EmailSender;
  /** null = no background polling; tests call dispatcher.drainUntilIdle() instead. */
  dispatcherIntervalMs?: number | null;
  /** Registers the /debug routes. Opt-in: defaults to DEBUG_ENDPOINTS=1, so a deploy can't expose them by accident. */
  debugEndpoints?: boolean;
  logger?: false | ('error' | 'warn' | 'log')[];
};

export type AppHandle = {
  app: INestApplication;
  db: Db;
  emailSender: EmailSender;
  alerts: Alerts;
  metrics: Metrics;
  dispatcher: OutboxDispatcher;
  close(): Promise<void>;
};

/** Single composition root, used by main.ts, the e2e tests and the simulator. */
export async function createApp(options: CreateAppOptions = {}): Promise<AppHandle> {
  const db = options.db ?? (await createPgliteDb());
  const emailSender = options.emailSender ?? new FakeEmailSender();
  const debug = options.debugEndpoints ?? process.env.DEBUG_ENDPOINTS === '1';

  @Module({
    controllers: [HealthController, MetricsController, ReservationsController, OutboxController, EventsController, ...(debug ? [DebugController] : [])],
    providers: [
      { provide: DB, useValue: db },
      { provide: EMAIL_SENDER, useValue: emailSender },
      // Not `??`: null must stay null (it means "no polling").
      { provide: DISPATCHER_INTERVAL_MS, useValue: options.dispatcherIntervalMs === undefined ? 500 : options.dispatcherIntervalMs },
      Metrics,
      Alerts,
      ReservationsRepository,
      OutboxRepository,
      EventLogRepository,
      ReservationsService,
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
    metrics: app.get(Metrics),
    dispatcher,
    async close() {
      await app.close();
      await db.close();
    },
  };
}
