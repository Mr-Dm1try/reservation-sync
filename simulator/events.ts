import { ReservationEvent, ReservationEventType, ReservationSnapshot } from '../src/events/reservation-event';

const BASE_TIME = Date.parse('2026-03-01T10:00:00.000Z');

export function defaultSnapshot(reservationId: string): ReservationSnapshot {
  return {
    status: 'pending',
    guest: { name: `Guest ${reservationId}`, email: `${reservationId}@guest.example` },
    checkIn: '2026-04-10',
    checkOut: '2026-04-14',
    roomType: 'double',
  };
}

/**
 * Builds one reservation's clean history: each call to `next()` produces the next event,
 * one minute after the previous one, carrying the full snapshot (previous state + patch).
 *
 *   const r = history('r1');
 *   const created   = r.next('reservation.created');
 *   const confirmed = r.next('reservation.updated', { status: 'confirmed' });
 */
export function history(reservationId: string, startAt = BASE_TIME) {
  let state = defaultSnapshot(reservationId);
  let n = 0;
  let at = startAt;

  return {
    next(
      type: ReservationEventType,
      patch: Partial<ReservationSnapshot> = {},
      opts: { stepMs?: number; occurredAt?: string; eventId?: string } = {},
    ): ReservationEvent {
      n++;
      at += opts.stepMs ?? 60_000;
      const status = type === 'reservation.cancelled' ? 'cancelled' : (patch.status ?? state.status);
      state = { ...state, ...patch, status };
      return {
        eventId: opts.eventId ?? `${reservationId}-e${n}`,
        type,
        reservationId,
        occurredAt: opts.occurredAt ?? new Date(at).toISOString(),
        data: structuredClone(state),
      };
    },
  };
}

/** Same event, different payload (a source bug the catalogue exercises). */
export function withData(event: ReservationEvent, patch: Partial<ReservationSnapshot>): ReservationEvent {
  return { ...event, data: { ...event.data, ...patch } };
}
