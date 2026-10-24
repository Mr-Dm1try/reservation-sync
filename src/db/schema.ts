export const SCHEMA_SQL = `
-- One row per reservation: the last applied event (its ordering key + full snapshot).
CREATE TABLE IF NOT EXISTS reservations_last_event (
  reservation_id text PRIMARY KEY,
  occurred_at    timestamptz NOT NULL,   -- ordering key, part 1 (from the last applied event)
  last_event_id  text NOT NULL,          -- ordering key, part 2 (tie-break)
  status         text NOT NULL,
  data           jsonb NOT NULL,         -- full ReservationSnapshot of the last applied event
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox. The unique key is what makes the confirmation email happen once.
CREATE TABLE IF NOT EXISTS outbox (
  key             text PRIMARY KEY,      -- e.g. 'confirmation:{reservationId}'
  reservation_id  text NOT NULL,
  kind            text NOT NULL,         -- e.g. 'confirmation_email'
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending',  -- pending | sent | skipped (cancelled before send)
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (next_attempt_at) WHERE status = 'pending';

-- Append-only log of every delivery, duplicates included. Audit and debugging only, never read
-- for dedupe (DECISIONS.md, section 11). Envelope columns are nullable: a rejected body may lack them.
CREATE TABLE IF NOT EXISTS events_received (
  id             bigserial PRIMARY KEY,  -- received order
  received_at    timestamptz NOT NULL DEFAULT now(),
  event_id       text,
  reservation_id text,
  type           text,
  occurred_at    timestamptz,
  outcome        text NOT NULL,          -- applied | duplicate | stale | ignored | rejected
  body           jsonb NOT NULL          -- raw body as received (holds guest PII)
);

CREATE INDEX IF NOT EXISTS events_received_reservation_idx ON events_received (reservation_id, received_at);
`;
