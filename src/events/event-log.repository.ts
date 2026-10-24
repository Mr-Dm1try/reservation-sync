import { Inject, Injectable } from '@nestjs/common';
import { DB, Db, Queryable } from '../db/db';

export type LoggedOutcome = 'applied' | 'duplicate' | 'stale' | 'ignored' | 'rejected';

export type ReceivedEventView = {
  id: number;
  receivedAt: string;
  eventId: string | null;
  reservationId: string | null;
  type: string | null;
  occurredAt: string | null;
  outcome: LoggedOutcome;
  body: unknown;
};

type ReceivedEventRow = {
  id: bigint | number | string; // int8: the driver may not return a plain number
  received_at: Date;
  event_id: string | null;
  reservation_id: string | null;
  type: string | null;
  occurred_at: Date | null;
  outcome: LoggedOutcome;
  body: unknown;
};

/** Read cap for GET /events: the newest N deliveries are returned, so recent ones are never cut. */
export const EVENT_LOG_READ_LIMIT = 1000;

/**
 * SQL for the append-only events_received table (DECISIONS.md, section 11). Audit and
 * debugging only: nothing reads it to decide anything.
 */
@Injectable()
export class EventLogRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Appends one delivery. Pass the apply transaction for applied/duplicate/stale, the db otherwise. */
  async record(q: Queryable, body: unknown, outcome: LoggedOutcome): Promise<void> {
    const f = envelopeFields(body);
    await q.query(
      `INSERT INTO events_received (event_id, reservation_id, type, occurred_at, outcome, body)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [f.eventId, f.reservationId, f.type, f.occurredAt, outcome, JSON.stringify(body ?? null)],
    );
  }

  /**
   * The newest `limit` deliveries (optionally for one reservation), returned in received order.
   * `truncated` = older rows exist that were left out.
   */
  async list(reservationId?: string, limit = EVENT_LOG_READ_LIMIT): Promise<{ events: ReceivedEventView[]; truncated: boolean }> {
    const rows = await this.db.query<ReceivedEventRow>(
      `SELECT id, received_at, event_id, reservation_id, type, occurred_at, outcome, body
       FROM events_received
       WHERE $1::text IS NULL OR reservation_id = $1
       ORDER BY id DESC
       LIMIT $2`,
      [reservationId ?? null, limit + 1],
    );
    const truncated = rows.length > limit;
    return { events: rows.slice(0, limit).reverse().map(toView), truncated };
  }
}

/**
 * Best-effort envelope fields from any body, valid or not: strings are taken as they are,
 * occurredAt only if it parses as a date (so a garbage value can't fail the insert).
 */
export function envelopeFields(body: unknown) {
  const o = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const occurredAt = str(o.occurredAt);
  return {
    eventId: str(o.eventId),
    reservationId: str(o.reservationId),
    type: str(o.type),
    occurredAt: occurredAt && !Number.isNaN(Date.parse(occurredAt)) ? new Date(occurredAt).toISOString() : null,
  };
}

function toView(row: ReceivedEventRow): ReceivedEventView {
  return {
    id: Number(row.id),
    receivedAt: new Date(row.received_at).toISOString(),
    eventId: row.event_id,
    reservationId: row.reservation_id,
    type: row.type,
    occurredAt: row.occurred_at && new Date(row.occurred_at).toISOString(),
    outcome: row.outcome,
    body: row.body,
  };
}
