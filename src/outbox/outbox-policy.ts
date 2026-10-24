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

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/** Exponential backoff after the given (1-based) failed attempt: 1s, 2s, 4s ... capped at 5 min. */
export function retryDelayMs(attempt: number): number {
  // 2 ** n is a double: past 2^1023 it becomes Infinity, which the cap still handles.
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
}
