export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reservations (
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
  status          text NOT NULL DEFAULT 'pending',  -- pending | sent
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (next_attempt_at) WHERE status = 'pending';
`;
