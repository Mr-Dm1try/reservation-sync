import { ReservationSnapshot } from '../events/reservation-event';

/** Shape returned by GET /reservations and GET /reservations/:id. */
export type ReservationView = ReservationSnapshot & {
  reservationId: string;
  /** occurredAt of the last applied event, normalised to UTC ISO with milliseconds. */
  occurredAt: string;
  lastEventId: string;
};
