import { ReservationEvent } from '../src/events/reservation-event';
import { Expectation } from './scenario';

/**
 * Independent "expected result" for a set of delivered events, written as simply as possible
 * and deliberately NOT sharing code with the app: for each reservation, the delivered event
 * with the greatest (occurredAt, eventId) wins. The app reaches its state incrementally with
 * row locks; the e2e tests check both agree.
 */
export function compareKey(a: ReservationEvent, b: ReservationEvent): number {
  const ta = Date.parse(a.occurredAt);
  const tb = Date.parse(b.occurredAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.eventId === b.eventId ? 0 : a.eventId < b.eventId ? -1 : 1;
}

export function expectedFinalEvents(delivered: ReservationEvent[]): Map<string, ReservationEvent> {
  const winners = new Map<string, ReservationEvent>();
  for (const event of delivered) {
    const current = winners.get(event.reservationId);
    if (!current || compareKey(event, current) > 0) winners.set(event.reservationId, event);
  }
  return winners;
}

/**
 * Expectation for any delivery order of `delivered`:
 *  - state: the max-key event per reservation;
 *  - emails: exactly 1 if the final status is confirmed; at most 1 if some delivered snapshot
 *    was confirmed (whether it was applied depends on order); otherwise 0.
 */
export function expectationFor(delivered: ReservationEvent[], allReservationIds: string[]): Expectation {
  const winners = expectedFinalEvents(delivered);
  const expectation: Expectation = { reservations: {}, emails: {} };

  for (const id of allReservationIds) {
    const winner = winners.get(id);
    if (!winner) {
      expectation.reservations[id] = 'absent';
      continue;
    }
    expectation.reservations[id] = { ...winner.data, lastEventId: winner.eventId };
    const everConfirmed = delivered.some((e) => e.reservationId === id && e.data.status === 'confirmed');
    if (winner.data.status === 'confirmed') expectation.emails[id] = 1;
    else if (everConfirmed) expectation.emails[id] = 'atMostOne';
  }
  return expectation;
}
