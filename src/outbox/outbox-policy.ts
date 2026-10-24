import { ReservationStatus } from '../events/reservation-event';

/**
 * Outbox business rules, pure (DECISIONS.md, section 4). The dispatcher does the I/O; this
 * decides what to do with each claimed entry.
 */

export type SendDecision = { action: 'send' } | { action: 'skip'; reason: string };

/** `reservationStatus` is the reservation's status at send time (undefined = no such row). */
export function sendDecision(kind: string, reservationStatus: ReservationStatus | undefined): SendDecision {
  // Don't tell a guest "confirmed" about a booking that was cancelled after we queued the email.
  if (kind === 'confirmation_email' && reservationStatus === 'cancelled') {
    return { action: 'skip', reason: 'reservation cancelled before send' };
  }
  return { action: 'send' };
}

/** How long an entry keeps retrying before it is dead-lettered: long enough to ride out a provider outage. */
export const DEFAULT_RETRY_WINDOW_MS = 2 * 60 * 60_000;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/** Exponential backoff after the given (1-based) failed attempt: 1s, 2s, 4s ... capped at 5 min. */
export function retryDelayMs(attempt: number): number {
  // 2 ** n is a double: past 2^1023 it becomes Infinity, which the cap still handles.
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
}

/**
 * Validates the configured window at boot. A typo in OUTBOX_RETRY_WINDOW_MS would otherwise be
 * NaN, and `x > NaN` is always false: nothing would ever be dead-lettered.
 */
export function retryWindowMs(raw: number | string): number {
  const ms = typeof raw === 'number' ? raw : raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`OUTBOX_RETRY_WINDOW_MS must be a non-negative number of milliseconds, got ${JSON.stringify(raw)}`);
  }
  return ms;
}

export type FailureDecision = { action: 'retry'; delayMs: number } | { action: 'dead-letter' };

/**
 * After a failed send: retry with backoff while the next attempt still falls inside the retry
 * window (measured from `pending_since`), otherwise dead-letter it so a human sees it. A time
 * window, not an attempt count, because the requirement is "survive an outage of X", and a
 * count would silently change meaning if the backoff did.
 */
export function onSendFailure(
  entry: { attempts: number; pendingForMs: number },
  retryWindowMs: number,
): FailureDecision {
  const delayMs = retryDelayMs(entry.attempts);
  return entry.pendingForMs + delayMs > retryWindowMs ? { action: 'dead-letter' } : { action: 'retry', delayMs };
}
