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
  status          text NOT NULL DEFAULT 'pending',  -- pending | sent | skipped (cancelled before send) | failed (dead-lettered)
  attempts        integer NOT NULL DEFAULT 0,
  pending_since   timestamptz NOT NULL DEFAULT now(),  -- start of the current retry window
  failed_at       timestamptz,            -- when it was dead-lettered
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

-- For databases created before the dead-letter columns existed (PGLITE_DATA_DIR).
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS pending_since timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS failed_at timestamptz;

CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (next_attempt_at) WHERE status = 'pending';
`;
