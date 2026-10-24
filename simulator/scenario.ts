import { ReservationEvent, ReservationSnapshot } from '../src/events/reservation-event';

export type Outcome = 'applied' | 'duplicate' | 'stale' | 'ignored';

/** One delivery action against the webhook. */
export type Step =
  | { send: ReservationEvent; status?: 200; outcome?: Outcome }
  | { sendConcurrently: ReservationEvent[] }
  /** Bodies that are not valid events (malformed, unknown type...). */
  | { sendRaw: unknown; status: 200 | 400; outcome?: Outcome }
  /** The fake email provider fails its next `count` sends (transient errors). */
  | { emailSenderFails: number }
  /** Let the outbox finish now (same as the final settle), e.g. so an entry dead-letters mid-scenario. */
  | { drainOutbox: true }
  /** The operator's bulk retry, POST /outbox/retry-failed. `requeued` = expected entry count. */
  | { retryFailedEmails: true; requeued?: number };

export type ExpectedReservation = Partial<ReservationSnapshot> & { lastEventId?: string };

export type Expectation = {
  /** Expected final state per reservation; 'absent' = must not exist. */
  reservations: Record<string, ExpectedReservation | 'absent'>;
  /**
   * Confirmation emails actually delivered per reservation. A number is exact; 'atMostOne'
   * is for order-dependent cases (e.g. confirmed then cancelled) in generated scenarios.
   * Reservations not listed must have 0.
   */
  emails: Record<string, number | 'atMostOne'>;
  /**
   * Reservations whose email count depends on whether the dispatcher ran between two deliveries
   * (e.g. confirmed, then cancelled). Exact in-process, where nothing sends until settle; against a
   * live server with background polling the CLI relaxes them to 'atMostOne'.
   */
  timingDependentEmails?: string[];
  /** Default: no alerts at all. */
  alerts?: { timestampTie?: number; outboxDeadLettered?: number };
  /** Default true: reservations not listed in `reservations` must not exist. */
  exhaustive?: boolean;
};

export type Scenario = {
  name: string;
  /** Catalogue row in docs/DECISIONS.md section 8, for named scenarios. */
  catalogue?: number;
  seed?: number;
  /** App settings for this scenario (in-process target only; a live server has its own). */
  app?: { outboxRetryWindowMs?: number };
  /** Why the CLI skips it against a live server (e.g. needs `app` settings, or hours of real backoff). */
  inProcessOnly?: string;
  steps: Step[];
  expect: Expectation;
};
