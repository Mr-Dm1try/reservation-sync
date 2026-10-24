import { Inject, Injectable } from '@nestjs/common';
import { DB, Db, Queryable } from '../db/db';
import { ReservationEvent, ReservationSnapshot } from '../events/reservation-event';
import { StoredKey } from './decide';
import { ReservationView } from './reservation-view';

type ReservationRow = {
  reservation_id: string;
  occurred_at: Date;
  last_event_id: string;
  data: ReservationSnapshot;
};

/**
 * SQL for the reservations_last_event table. No business rules here: the service runs the
 * steps of DECISIONS.md section 5 (option 1) in one transaction and decides with decide().
 */
@Injectable()
export class ReservationsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Stores the event's snapshot if the reservation has no row yet. False = a row exists. */
  async insertIfAbsent(tx: Queryable, event: ReservationEvent): Promise<boolean> {
    const inserted = await tx.query(
      `INSERT INTO reservations_last_event (reservation_id, occurred_at, last_event_id, status, data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (reservation_id) DO NOTHING
       RETURNING reservation_id`,
      rowParams(event),
    );
    return inserted.length > 0;
  }

  /** Locks the reservation's row until the transaction ends and returns its ordering key. */
  async lockCurrent(tx: Queryable, reservationId: string): Promise<StoredKey> {
    const [row] = await tx.query<Pick<ReservationRow, 'occurred_at' | 'last_event_id'>>(
      `SELECT occurred_at, last_event_id FROM reservations_last_event WHERE reservation_id = $1 FOR UPDATE`,
      [reservationId],
    );
    return { occurredAt: row.occurred_at, lastEventId: row.last_event_id };
  }

  async replace(tx: Queryable, event: ReservationEvent): Promise<void> {
    await tx.query(
      `UPDATE reservations_last_event
       SET occurred_at = $2, last_event_id = $3, status = $4, data = $5, updated_at = now()
       WHERE reservation_id = $1`,
      rowParams(event),
    );
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

/** occurred_at is stored normalised to UTC with ms, whatever offset the source sent. */
function rowParams(event: ReservationEvent): unknown[] {
  const occurredAt = new Date(event.occurredAt).toISOString();
  return [event.reservationId, occurredAt, event.eventId, event.data.status, JSON.stringify(event.data)];
}

function toView(row: ReservationRow): ReservationView {
  return {
    ...row.data,
    reservationId: row.reservation_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    lastEventId: row.last_event_id,
  };
}
