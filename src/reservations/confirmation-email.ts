import { ReservationEvent } from '../events/reservation-event';

export type ConfirmationEmailPayload = { to: string; subject: string; body: string };

export const confirmationKey = (reservationId: string) => `confirmation:${reservationId}`;

/** Rendered from the snapshot that made the reservation confirmed (DECISIONS.md, section 4). */
export function confirmationEmail({ reservationId, data }: ReservationEvent): ConfirmationEmailPayload {
  return {
    to: data.guest.email,
    subject: `Your reservation ${reservationId} is confirmed`,
    body:
      `Hi ${data.guest.name},\n\n` +
      `your ${data.roomType} room is confirmed from ${data.checkIn} to ${data.checkOut}.\n` +
      `Reservation: ${reservationId}`,
  };
}
