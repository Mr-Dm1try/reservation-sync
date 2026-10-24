import { Inject, Injectable } from '@nestjs/common';
import { DB, Db } from '../db/db';
import { ReservationEvent, ReservationSnapshot } from '../events/reservation-event';
import { confirmationEmail, confirmationKey } from './confirmation-email';
import { decide, Decision } from './decide';
import { ReservationView } from './reservation-view';

export type ApplyResult = Decision & {
  /** eventId of the stored record before this event, if there was one (for the tie alert). */
  storedEventId?: string;
};

type ReservationRow = {
  reservation_id: string;
  occurred_at: Date;
  last_event_id: string;
  data: ReservationSnapshot;
};

/**
 * Applies events with "insert if absent, then lock the row and decide in code"
 * (DECISIONS.md, section 5, option 1). One transaction per event; the primary key settles the
 * race for the first write, and the row lock serializes everything after it.
 */
@Injectable()
export class ReservationsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  apply(event: ReservationEvent): Promise<ApplyResult> {
    const occurredAt = new Date(event.occurredAt).toISOString();
    const params = [event.reservationId, occurredAt, event.eventId, event.data.status, JSON.stringify(event.data)];

    return this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO reservations_last_event (reservation_id, occurred_at, last_event_id, status, data)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (reservation_id) DO NOTHING
         RETURNING reservation_id`,
        params,
      );

      let result: ApplyResult;
      if (inserted.length > 0) {
        result = { outcome: 'applied', tie: false };
      } else {
        const [current] = await tx.query<Pick<ReservationRow, 'occurred_at' | 'last_event_id'>>(
          `SELECT occurred_at, last_event_id FROM reservations_last_event WHERE reservation_id = $1 FOR UPDATE`,
          [event.reservationId],
        );
        result = {
          ...decide({ occurredAt: current.occurred_at, lastEventId: current.last_event_id }, event),
          storedEventId: current.last_event_id,
        };
        if (result.outcome === 'applied') {
          await tx.query(
            `UPDATE reservations_last_event
             SET occurred_at = $2, last_event_id = $3, status = $4, data = $5, updated_at = now()
             WHERE reservation_id = $1`,
            params,
          );
        }
      }

      // Same transaction as the state change. The unique key makes this "one email, ever".
      if (result.outcome === 'applied' && event.data.status === 'confirmed') {
        await tx.query(
          `INSERT INTO outbox (key, reservation_id, kind, payload)
           VALUES ($1, $2, 'confirmation_email', $3)
           ON CONFLICT (key) DO NOTHING`,
          [confirmationKey(event.reservationId), event.reservationId, JSON.stringify(confirmationEmail(event))],
        );
      }
      return result;
    });
  }

  async findOne(reservationId: string): Promise<ReservationView | undefined> {
    const [row] = await this.db.query<ReservationRow>(
      `SELECT reservation_id, occurred_at, last_event_id, data FROM reservations_last_event WHERE reservation_id = $1`,
      [reservationId],
    );
    return row && toView(row);
  }

  async findAll(): Promise<ReservationView[]> {
    const rows = await this.db.query<ReservationRow>(
      `SELECT reservation_id, occurred_at, last_event_id, data FROM reservations_last_event ORDER BY reservation_id`,
    );
    return rows.map(toView);
  }
}

function toView(row: ReservationRow): ReservationView {
  return {
    ...row.data,
    reservationId: row.reservation_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    lastEventId: row.last_event_id,
  };
}
