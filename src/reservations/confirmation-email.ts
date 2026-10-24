import { ReservationEvent } from '../events/reservation-event';
import { NewOutboxEntry } from '../outbox/outbox.repository';

export const confirmationKey = (reservationId: string) => `confirmation:${reservationId}`;

/**
 * The outbox entry for a reservation's confirmation email, rendered from the snapshot that made
 * it confirmed (DECISIONS.md, section 4). The key is per reservation: one email, ever.
 */
export function confirmationEntry({ reservationId, data }: ReservationEvent): NewOutboxEntry {
  return {
    key: confirmationKey(reservationId),
    reservationId,
    kind: 'confirmation_email',
    payload: {
      to: data.guest.email,
      subject: `Your reservation ${reservationId} is confirmed`,
      body:
        `Hi ${data.guest.name},\n\n` +
        `your ${data.roomType} room is confirmed from ${data.checkIn} to ${data.checkOut}.\n` +
        `Reservation: ${reservationId}`,
    },
  };
}
