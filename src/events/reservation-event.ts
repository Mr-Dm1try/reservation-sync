import { z } from 'zod';

/**
 * Contract for events coming from the PMS-like source (see docs/DECISIONS.md, section 2).
 *
 * Parsing is two-phase on purpose:
 *  1. `eventEnvelopeSchema` validates the fields every event must have. Failing it -> 400.
 *  2. If `type` is one we know, `reservationEventSchema` validates the full event (-> 400 on failure).
 *     An unknown `type` with a valid envelope is acknowledged (200) and ignored, so the source
 *     can add event types without breaking us.
 */

export const KNOWN_EVENT_TYPES = [
  'reservation.created',
  'reservation.updated',
  'reservation.cancelled',
] as const;

export type ReservationEventType = (typeof KNOWN_EVENT_TYPES)[number];

export const RESERVATION_STATUSES = ['pending', 'confirmed', 'cancelled'] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1),
  type: z.string().min(1),
  reservationId: z.string().min(1),
  /** The source's time of change (like `updatedAt`), not the delivery time. Used for ordering. */
  occurredAt: isoDateTime,
});

export const reservationSnapshotSchema = z.object({
  status: z.enum(RESERVATION_STATUSES),
  guest: z.object({
    name: z.string().min(1),
    email: z.email(),
  }),
  checkIn: isoDate,
  checkOut: isoDate,
  roomType: z.string().min(1),
});

export const reservationEventSchema = eventEnvelopeSchema.extend({
  type: z.enum(KNOWN_EVENT_TYPES),
  /** Full state of the reservation after this event (snapshot, not delta). */
  data: reservationSnapshotSchema,
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type ReservationSnapshot = z.infer<typeof reservationSnapshotSchema>;
export type ReservationEvent = z.infer<typeof reservationEventSchema>;

export function isKnownEventType(type: string): type is ReservationEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(type);
}
