# Extras plan: outbox dead-letter + raw event log

Base: `main` (everything through #5 is merged). Two small PRs, built one after the other in
this thread, because both touch `schema.ts`, the service, metrics and DECISIONS.md (in
parallel they would conflict). Budget: about 30 min for A, 20-25 min for B.

## A. Outbox dead-letter (PR "outbox: dead-letter after N attempts")

**Problem:** today a failing email retries forever (backoff caps at 5 min), so a permanently
broken send is never surfaced. It doesn't drop the email, but it never stops or tells anyone.

**Rule (pure, in `outbox-policy.ts`): time window, not attempt count.**
`onSendFailure({ attempts, pendingForMs }) -> { action: 'retry', delayMs } | { action: 'dead-letter' }`.
Keep retrying (backoff 1s, 2s, 4s ... capped at 5 min) until the entry has been pending for
**2 hours** (`OUTBOX_RETRY_WINDOW_MS`, default 2h), then dead-letter it. A window states the
real requirement directly ("survive a 2h provider outage"); an attempt count only does so
indirectly, and breaks if the backoff changes. With the 5 min cap that's about 30 attempts.
(The first draft said 8 attempts, about 2 min: too short, since any provider outage would
mean resending by hand.)

**Changes:**
1. Outbox gets a 4th status, `failed` (dead-lettered), plus a `pending_since timestamptz`
   column. It's set on insert, on revive from `skipped`, and on manual retry, so each new
   retry episode gets a full window (`created_at` would be wrong after a revive).
   `OutboxEntryView` and the metrics gauge label set are updated.
2. `OutboxRepository.markDeadLettered(key, error)`: `status = 'failed'`, keeps `last_error`.
3. Dispatcher: on a send error, ask the policy. Dead-letter -> mark it, bump
   `outbox_send_total{result="dead_lettered"}`, and raise `Alerts.outboxDeadLetter(key)`
   (error log + new counter `outbox_dead_letter_total`: alert on any increase).
   `outbox_oldest_pending_age_seconds` (already in #5) is the early warning *during* an outage.
4. **Bulk retry of failed entries (operator action, after the outage is fixed):**
   `POST /outbox/retry-failed`: every `failed` entry -> `pending`, attempts 0,
   `pending_since = now()`. It returns how many were requeued. An optional
   `?failedSince=<ISO>` limits it to one outage. It's safe to call twice: it only touches
   `failed` rows, and the provider idempotency key still guards the send. (No per-key route;
   bulk is what you need after an outage.) No auth in this exercise; in production they go behind internal auth
   (stated in DECISIONS and README). Automatic revive stays as is (`enqueue` only revives `skipped`).
5. README "Next steps": remove the item. DECISIONS section 4: add the window rule, the
   trade-off, and the retry routes.

**Tests:**
- Policy unit test: retry just inside the window, dead-letter at or after it, delay capped.
- Dispatcher test with a tiny window: provider keeps failing -> `failed`, counters bumped,
  never claimed again; then `retry-failed` -> sent exactly once.
- `createApp({ outboxRetryWindowMs })` option, so e2e can use a small window.
- Catalogue **#21** "long provider outage": `emailSenderFails: 30`, then it recovers, and
  still exactly one email. It runs within the default 2h window, because drainUntilIdle
  ignores backoff.
- `core.e2e`: small window -> dead-lettered -> `POST /outbox/retry-failed` -> one email.

## B. Raw event log (PR "events: append-only log of every delivery")

**Problem:** we keep only the latest snapshot per reservation. "What did the PMS actually
send us for r04, and in what order?" can't be answered, and we can't replay.

**Table `events_received`** (append-only, one row per *delivery*, duplicates included):
`id bigserial PK, received_at timestamptz default now(), event_id, reservation_id, type,
occurred_at` (all nullable, since a malformed body may lack them), `outcome text NOT NULL`
(applied | duplicate | stale | ignored | rejected), `body jsonb NOT NULL`.
Index `(reservation_id, received_at)`.

**Where it is written:**
- applied / duplicate / stale: **inside the apply transaction**, so the log and the state
  can never disagree.
- ignored / rejected: a separate insert (there's no state change to share a transaction with).
- 500s are not logged: the transaction rolled back and the source will retry. They are still
  in app logs and the `error` metric.

**Explicitly NOT used for dedupe.** Correctness still comes from the ordering key (DECISIONS
section 3); the log is audit and debugging only, so it can be truncated or retained freely.

**Read side:** `GET /events?reservationId=r04` returns deliveries in received order (good for
the live demo: "here are the 4 deliveries for r01: applied, applied, stale, duplicate").

**Tests:** service test (one row per delivery with the right outcome, including duplicate,
rejected and ignored); a harness invariant: rows added == deliveries sent, and per-step
outcomes match the log (cheap in-process, through the DB handle).

**Stated, not built (DECISIONS + README):**
- Retention: bodies contain guest name and email (PII), so delete after N days.
- Replay: re-applying the log in received order onto empty tables must reproduce the current
  state. That holds by design, since processing is idempotent; it would make a nice
  `npm run replay` later.

## Decisions for Dmitry
1. ~~Dead-letter after 8 attempts~~ -> decided: 2h window, plus a bulk retry-failed route.
2. ~~Log rejected/malformed bodies too?~~ -> decided: yes, rejected bodies are logged (outcome `rejected`).
