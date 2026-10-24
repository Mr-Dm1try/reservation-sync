# Reservation Event Sync: Design Decisions

Status: draft for review (step 1). Stack: TypeScript, NestJS, Jest, Postgres via PGlite (in-process, no Docker).

## 1. The problem in one line

Turn an unreliable stream of reservation events (duplicated, reordered, redelivered,
sometimes concurrently) into a correct local view, and send exactly one confirmation
email per reservation.

## 2. Event shape (we define it, so we define it to be safe)

```ts
type ReservationEvent = {
  eventId: string;          // unique per logical event; a redelivery reuses the same id
  type: 'reservation.created' | 'reservation.updated' | 'reservation.cancelled';
  reservationId: string;
  occurredAt: string;       // ISO-8601, the source's time of change (like `updatedAt`); used for ordering
  data: ReservationSnapshot; // full state of the reservation after this event
};

type ReservationSnapshot = {
  status: 'pending' | 'confirmed' | 'cancelled';
  guest: { name: string; email: string };
  checkIn: string;          // YYYY-MM-DD
  checkOut: string;
  roomType: string;
};
```

### Decision: full snapshot, not delta
Each event carries the whole reservation. That makes ordering simple: the event with the
latest `occurredAt` wins and older ones are ignored. With deltas we would have to buffer
events and wait for gaps to fill, which is more code, more failure modes, and an
unbounded wait if an event is lost.
*Trade-off:* bigger payloads; we can't reconstruct the field-level history. Acceptable.

### Decision: order by `occurredAt`, tie-break by `eventId`
None of the PMS webhook APIs we checked (Mews, Cloudbeds, Apaleo, Guesty) document a
per-reservation sequence number; a timestamp is what you usually get, and some send no
timestamp at all (see "Real-world check" below).
So the ordering key is the pair `(occurredAt, eventId)`, compared
lexicographically: later time wins; equal times fall back to comparing `eventId` so the
result is deterministic no matter which arrives first.

Assumptions this relies on (stated in the README):
- `occurredAt` is the time the reservation **changed at the source**, not the time the
  webhook was sent. A retry must carry the original `occurredAt`, or an old change could win.
- One clock (or well-synced clocks) stamps a given reservation. Skew between source nodes
  smaller than the gap between two edits is harmless; larger skew can reorder edits.
- Timestamps are normalised to UTC epoch milliseconds before comparing (no string
  comparison of mixed offsets).
- The tie-break is arbitrary: with two edits in the same millisecond we pick one
  deterministically, but it may not be the "real" last one. This should never happen with a ms/µs-precision source clock, so it raises an **alert**
  (error log + `reservation_event_timestamp_tie_total` counter, section 10)
  rather than a warning: it means the source's ordering can't be trusted for that reservation.

#### Why not a `version` field? (and what it would simplify if the source had one)
A per-reservation sequence number (`version: 1, 2, 3...`) is unlikely in a real PMS feed, so
we don't assume it. If the source does provide one, several things get simpler:
- **No clock assumptions:** ordering is an integer comparison, immune to skew and retries
  that re-stamp timestamps.
- **No tie-break:** two different events never share a version, so equal version + different
  payload is a detectable source bug (`conflict`) instead of a silent arbitrary pick.
- **Gap detection:** receiving v3 while holding v1 tells us v2 is missing. Options: hold
  v3 for a short window (seconds) waiting for v2 to arrive, then fall back to fetching the
  reservation from the source API or alerting if it doesn't. With snapshots, waiting isn't
  needed for correct state (v3 already contains everything v2 changed); it matters for
  delta payloads, or to delay side effects like the email until the history is complete.
  With timestamps, gaps are invisible, so none of this is possible.
- **Simpler DB guard:** `UPDATE ... WHERE version < $1` instead of a tuple comparison.
Switching is a one-function change: the comparator inside `decide()`.

#### Real-world check (checked 2026-10-24 against public docs)

| PMS | Sequence/version per entity? | Timestamp | Payload | Ordering / duplicates per docs |
|---|---|---|---|---|
| [Cloudbeds](https://developers.cloudbeds.com/docs/webhooks-1) | No (`version: "1.0"` is the payload schema version) | `timestamp`, UNIX with microseconds; **retries keep the original event time** | Small snapshot (ids, dates, status) | "Order of the events is not guaranteed"; resent on >2s timeout; 5 retries |
| [Apaleo](https://apaleo.dev/guides/webhook/webhooks-payload.html) | No | `timestamp` (epoch ms) | IDs only (`entityId`), fetch from API | Not documented |
| [Mews](https://docs.mews.com/connector-api/events/wh-general) | No | None | IDs only, fetch from API | Retried on timeout; Added + Updated often arrive together |
| [Guesty](https://open-api-docs.guesty.com/docs/webhooks-reservations) | No documented field (legacy `__v` is undocumented) | v2 `meta.publishedAt`, documented as helping "mitigate race conditions" | Lean snapshot + `changedFields` | Update can arrive before create; one alteration can produce three legacy webhooks |

Takeaways:
- Our `occurredAt` assumption matches Cloudbeds and Guesty v2, including Cloudbeds'
  guarantee that a retry keeps the original timestamp.
- Several big PMSs use **thin webhooks** (ID only) and tell you to fetch the current
  reservation from their API. That sidesteps ordering entirely: whatever arrives, you
  fetch the latest state. We use snapshots because the challenge is about handling
  unreliable events, and we have no source API to call; "thin webhook + fetch" goes in the
  README as the production alternative.

### Decision: `confirmed` is a status, not an event type
A reservation can be created already confirmed, or confirmed later by an update. Making the
email depend on the *state* (status became confirmed) rather than on a specific event type
covers both, and survives a missing "confirmed" event.

## 3. Applying an event (the rules)

A pure function; the repository calls it inside a transaction that holds the row lock (section 5):

```
decide(current | undefined, event) -> { outcome: 'applied' | 'duplicate' | 'stale', tie: boolean }
```

Events are first partitioned by `reservationId`: `current` is the stored record for
`event.reservationId`, and the event key `(occurredAt, eventId)` is only ever compared
against that same reservation's stored key. There is no global ordering across
reservations, and none is needed: each reservation is an independent stream, which is
also what lets the per-reservation lock (section 5) serialize writes without a global lock.

| Situation | Outcome | Action |
|---|---|---|
| no local record | `applied` | create from snapshot (even if it's not a "created" event: missed events are fine) |
| event key `(occurredAt, eventId)` > current key | `applied` | replace with snapshot |
| event key == current key (redelivery of the latest applied event) | `duplicate` | no-op, ack 200 |
| event key < current key (redelivery of an older event, or a genuinely older one) | `stale` | no-op, ack 200 |
| same `occurredAt`, different `eventId` | `applied` or `stale` by `eventId` tie-break | **alert**: shouldn't happen, signals a source anomaly |
| malformed / unknown type | `rejected` | 400 for malformed; 200 + ignore for unknown type (forward compatible) |

### Decision: no processed-events store; idempotency comes from the ordering check
An event is applied only if its key is **strictly greater** than the stored key; anything
`<=` is a no-op. That alone makes processing idempotent: a redelivery is either the
latest applied event (key equal) or an older one (key smaller). So we keep only
`lastOccurredAt` + `lastEventId` per reservation, not a set of every `eventId` ever seen.

Why: a processed-events set grows forever (or needs a TTL, which reopens the duplicate
window), and it's a second source of truth that can disagree with the state.

What we give up, knowingly:
- **"Duplicate" vs "stale" is only distinguishable for the latest event** (equal key). An
  old redelivery is just reported as `stale`. Fine: both are no-ops; only logs differ.
- **Same `eventId` with a different payload** (source bug) is silently treated as a
  duplicate, keeping the first. Could be detected for the latest event by storing a
  payload hash; not worth it in the time-box.
- **Audit trail** of every received event. In production you'd keep a raw event log
  anyway (for replay and debugging), but it isn't needed for correctness.

Side effects stay safe because they are tied to an `applied` transition, and a no-op
never triggers one. The email additionally has its own idempotency key (section 4).

Cancellation is just a newer snapshot with `status: cancelled`; there is no special rule
for it. A late "updated" can never undo a cancel because it falls under the `stale` row. If the source later sends a *newer*
snapshot that un-cancels, we honour it (the source is the system of record).

## 4. Confirmation email: "exactly once"

True exactly-once delivery across a network does not exist; the honest goal is
**effectively once**: never send twice, never silently drop.

Design: **transactional outbox + idempotency key.**
1. When applying an event moves a reservation into `confirmed` **and** it has never had a
   confirmation, write an outbox entry with key `confirmation:{reservationId}` *in the same
   atomic step* as the state change. A unique key means a second insert is a no-op.
2. A dispatcher reads pending outbox entries, calls the (fake) email sender with the key as
   the idempotency key, then marks the entry `sent`.
3. Sender fails: entry stays pending, retried with backoff (1s doubling, capped at 5 min).
   Crash after send but before mark: retry happens, and the provider-side idempotency key stops
   the duplicate (the fake sender simulates this).
4. **Dead-letter after a time window, not an attempt count.** An entry keeps retrying for
   `OUTBOX_RETRY_WINDOW_MS` (default **2h**) measured from `pending_since` (when it became
   pending). When the next retry would land past the window, it is marked `failed` with its last
   error, and alerted (error log `outbox_dead_lettered` + `outbox_send_total{result="dead_lettered"}`).
   Why time: an attempt count with capped backoff gives up after a few minutes of provider
   outage, and then every guest from that outage needs a manual resend. Two hours rides out a
   typical incident; past that a human should look anyway (the confirmation is hours late).
5. **Bulk retry:** `POST /outbox/retry-failed[?failedSince=<ISO-8601>]` puts `failed` entries
   back to `pending` with a fresh window (`failedSince` scopes it to one incident). It only
   touches `failed` rows, so running it twice is harmless; the idempotency key still guards
   against a double send. Redeliveries and newer snapshots do **not** revive a `failed` entry
   (only `skipped` ones are revived): giving up is an operator-visible state, so it comes back
   through the operator. Internal route: in production it sits behind internal auth.

Rules (our assumptions):
- One confirmation per reservation, ever. Confirmed -> pending -> confirmed does not resend.
  *Example of how a resend could work if the business wanted it (not implemented):* make the
  idempotency key point at the **confirming transition** instead of the reservation, e.g.
  `confirmation:{reservationId}:{eventId}`, where `eventId` belongs to the event that moved
  the status from non-confirmed to confirmed. A redelivery of that same event is still a
  no-op (it isn't newer, so it never triggers a transition), but a real reconfirmation later is
  a new transition with a new key, so it sends. To protect guests from a flapping source,
  add a cooldown (e.g. skip if a confirmation went out in the last 24h) and/or a different
  template ("your booking is confirmed again"). The same trick covers "resend if the guest
  email changed": `confirmation:{reservationId}:{hash(guestEmail)}`.
- Guest email changed after confirming: no resend (could be an extra, "updated details" email).
- Cancelled before we ever saw it confirmed (e.g. the cancel arrives before the confirming update): no email.
  Good: we don't email a guest whose booking is already cancelled.
- Email reflects the latest known state at the time the outbox entry is created.
- Cancelled after we saw the confirm but before the email went out (e.g. confirm and cancel
  land within one dispatcher tick, or the entry sits in backoff): no email. The dispatcher
  checks the current status before sending and marks the entry `skipped`. If a newer snapshot
  confirms it again, the skipped entry goes back to `pending` (the guest never got one).
  A cancel that commits between the claim and the send (which can include the batch's earlier
  sends) can still slip through; closing it would mean holding a lock across the provider call.
  The skip itself is a compare-and-set on the reservation's status, so a reconfirmation that
  lands after the claim is never lost.

## 5. Concurrency

The same event can arrive twice at the same moment, and two different events for a
reservation that doesn't exist yet can race to create it. The tricky part is exactly that
first write: **there is no row to lock yet.** The answer is to lock on the *key*
(`reservationId`), not on a row, or to let a unique constraint arbitrate.

### Storage choice: PGlite (real Postgres, in-process)
We write the production SQL from day one instead of an in-memory map plus a hand-rolled
lock. [PGlite](https://pglite.dev) is Postgres compiled to WASM: `npm install`, no Docker,
a fresh database per test in milliseconds, and the same SQL runs unchanged on a real
Postgres by swapping the driver behind a small `Db` interface (`query`, `transaction`).

Options considered:
| Option | Verdict |
|---|---|
| PGlite | **Chosen.** Real Postgres dialect (`ON CONFLICT ... WHERE`, row-value comparison, `RETURNING`), zero setup |
| Postgres in docker-compose | Proves real concurrent races, but reviewers need Docker and setup eats the time-box. Extra: run the same test suite against it |
| SQLite | Supports similar upsert syntax, but not the production dialect |
| pg-mem (JS emulation) | Patchy on exactly the `ON CONFLICT ... WHERE` behaviour we rely on |
| In-memory map + keyed mutex | Simplest, but everything "production" would be a promise in the README |

Honest limitation: PGlite is a single connection, so two transactions never truly run in
parallel. The SQL below is race-safe by construction (Postgres semantics), but the test
suite can't *prove* it under real concurrency; that's what the docker-Postgres extra is for.

With the database doing the arbitration, **no application-level lock is needed**.

### How writes are made safe (option 1 is what we implement)
1. **Insert if absent, then lock the row and decide in code (implemented).** One
   transaction per event:
   ```sql
   -- a) first event for this reservation? insert it, and we're done (outcome: applied)
   INSERT INTO reservations_last_event (reservation_id, occurred_at, last_event_id, status, data)
   VALUES ($1, $2, $3, $4, $5)
   ON CONFLICT (reservation_id) DO NOTHING
   RETURNING reservation_id;
   -- b) otherwise the row exists now (ours or a concurrent one); lock it
   SELECT occurred_at, last_event_id, status FROM reservations_last_event
   WHERE reservation_id = $1 FOR UPDATE;
   -- c) decide(current, event) in TypeScript -> applied | duplicate | stale (+ tie flag -> alert)
   -- d) only if applied:
   UPDATE reservations_last_event SET occurred_at = $2, last_event_id = $3, status = $4, data = $5
   WHERE reservation_id = $1;
   -- e) if applied and status = 'confirmed':
   INSERT INTO outbox (key, reservation_id, payload)
   VALUES ('confirmation:' || $1, $1, $6) ON CONFLICT (key) DO NOTHING;
   ```
   The "no row to lock" race is settled by the primary key in step a: if two first events
   race, one inserts, the other's `INSERT` waits for that commit, does nothing, and then
   locks the now-existing row in step b. From step b on, the row lock serializes everything
   for that reservation. Because the code sees the stored row, **every outcome is known**:
   applied, duplicate (equal key), stale, and the timestamp tie that must raise an alert.
   It also gives us the previous status, needed for transition-based rules like the
   "resend on reconfirmation" example in section 4. The ordering rules live in one place,
   the pure `decide()` function from section 3, which is unit-tested on its own.
2. **Single conditional upsert, no lock (considered, rejected).**
   `INSERT ... ON CONFLICT (reservation_id) DO UPDATE SET ... WHERE (stored key) < (new key)
   RETURNING ...` is atomic and one round trip, but when nothing comes back we can't tell
   *why*: duplicate, stale and timestamp tie all look the same, so **the tie alert is lost**.
   (Postgres 18's `RETURNING OLD.*`, or copying the old values into `prev_*` columns in the
   `SET`, could recover it, at the cost of clarity.) Worth it only if write throughput on a
   single reservation ever becomes the bottleneck, which is unlikely.
3. **Advisory lock on the key**: `SELECT pg_advisory_xact_lock(hashtext($reservationId))`
   at the start of the transaction. Locks a number, not a row, so it works before the row
   exists. A hash collision only serializes two unrelated reservations; never incorrect.
   Equivalent to option 1; option 1 avoids the extra concept.
4. **Partition the queue by `reservationId`** at scale (Kafka message key, SQS FIFO
   `MessageGroupId`): one consumer per key at a time, so serialization comes from the
   infrastructure. The row-lock logic still stays, as defence against redelivery.

Options 2 to 4 are documented alternatives, not implemented.

The test generator computes the expected final state independently: for each reservation,
the delivered event with the greatest `(occurredAt, eventId)`. So end-to-end tests check
the incremental, lock-based path against a simple "take the max" oracle.

The email dispatcher claims pending outbox rows with `SELECT ... FOR UPDATE SKIP LOCKED`,
so several dispatcher instances never pick the same row (a no-op on PGlite, correct on Postgres).

## 6. Webhook contract

- `POST /webhooks/reservations` accepts one event (batch is an extra).
- Valid but duplicate/stale -> **200** so the source stops retrying. Malformed -> **400**.
  Internal error -> **500** so the source retries (safe, because processing is idempotent).
- Processing is inline (one transaction per event, then 200). At higher volume: persist the raw
  event, ack, process async.
- Read side: `GET /reservations/:id`, `GET /reservations`, `GET /outbox` (for the demo and tests).
- Operator: `POST /outbox/retry-failed[?failedSince=]` -> `{ requeued, keys }` (section 4); 400 on
  a bad date.

## 7. Module layout (NestJS)

```
src/
  events/        event schema + validation (zod)
  db/           Db interface, PGlite driver, schema migration (reservations, outbox)
  reservations/  decide() (pure), repository (insert-if-absent + row lock), service, controller
  outbox/        outbox repository, dispatcher (interval + retry)
  email/         EmailSender interface + FakeEmailSender (records sends, honours idempotency key, can fail)
simulator/       scenario types, named scenarios, generator + oracle, runner, CLI (step 1.5)
test/            decide() unit tests, repository tests on PGlite, e2e = runner over all scenarios
```

## 8. Test data and chaos catalogue (feeds step 1.5)

The generator first builds a **clean ground-truth history** per reservation (a sequence of snapshots with increasing `occurredAt`), then
applies **seeded chaos transforms**, so every run is reproducible and the expected result is
known.

| # | Case | How it's generated |
|---|---|---|
| 1 | Exact duplicate | re-emit the same event later in the stream |
| 2 | Concurrent duplicate | fire the same event N times in parallel |
| 3 | Update before create | swap the first two events |
| 4 | Late update after cancel | deliver an older update after the cancel |
| 5 | Gap / lost event | drop a middle update entirely |
| 6 | Lost first event | drop the "created" event, stream starts with an update |
| 7 | Very late replay | re-send an old event at the very end |
| 8 | Confirmation delivered many times | duplicate the confirming event 3-5x |
| 9 | Created already confirmed | v1 has `status: confirmed` |
| 10 | Confirm -> unconfirm -> reconfirm | status flips, must still be one email |
| 11 | Cancel arrives before confirm | expected: no email |
| 12 | Same `occurredAt`, different eventId | tie-break picks the same winner in any delivery order |
| 13 | Same eventId, different payload | source bug -> treated as duplicate, first one kept |
| 14 | Malformed / missing fields | expect 400, state untouched |
| 15 | Unknown event type | ignored, 200 |
| 16 | Mixed timestamp formats | same instant as `Z` vs `+02:00`, ms vs no ms; must compare equal |
| 17 | Many reservations interleaved | realistic mixed stream |
| 18 | Email sender transient failures | fake sender fails X% of calls; still one email each |
| 19 | Two different first events race | `created` and `updated` of a new reservation fired in parallel |
| 20 | Un-cancel by a newer snapshot | cancel, then a newer confirmed snapshot: honoured, still one email |
| 21 | Long provider outage inside the retry window | sender fails 30 times in a row: still exactly one email, no alert (in-process only: real backoff takes ~an hour) |
| 22 | Outage outlasts the retry window | entry dead-lettered and alerted, a redelivery doesn't revive it, bulk retry sends exactly once (in-process only: needs a zero window) |

**What the tests assert** (invariants, true for any ordering):
1. Final local state of each reservation == the delivered event with the greatest `(occurredAt, eventId)`.
2. At most one confirmation email per reservation, always.
3. Every reservation whose final state is `confirmed` has exactly one email.
4. No email was created for a reservation that was not `confirmed` at that moment.

Note: for "confirmed then cancelled" the email count is legitimately 0 or 1 depending on
delivery order, so invariant 3 only covers final-confirmed reservations. Worth calling out
in the walkthrough.

### 8.1 E2E verification harness: send, settle, assert

Every test case is a **scenario**: a delivery plan plus the state we expect afterwards. One
runner executes it end to end against the real app (HTTP controller, PGlite, outbox,
dispatcher, fake email sender), so we test what the webhook actually does, not just
`decide()`.

```ts
type Scenario = {
  name: string;                 // "late update after cancel"
  seed?: number;                // for generated scenarios; printed on failure to reproduce
  steps: Step[];
  expect: Expectation;
};

type Step =
  | { send: ReservationEvent; status?: 200 | 400 }     // default 200
  | { sendConcurrently: ReservationEvent[] }           // Promise.all, for race cases
  | { sendRaw: unknown; status: 400 }                  // malformed bodies
  | { emailSenderFails: number };                      // next N sends fail (transient errors)

type Expectation = {
  reservations: Record<string, Partial<ReservationSnapshot> & { lastEventId?: string } | 'absent'>;
  emails: Record<string, number>;   // reservationId -> confirmation emails actually delivered
  alerts?: { timestampTie?: number };
};
```

**Runner, in three phases:**
1. **Send.** Boot the Nest app in-process with a `FakeEmailSender`, on an emptied PGlite
   database (one PGlite per test file, tables truncated per scenario, because booting PGlite
   is the slow part). Execute the steps in order over real HTTP
   (supertest), asserting each response status.
2. **Settle.** Call `dispatcher.drainUntilIdle()`, which processes the outbox until there's
   nothing pending or retryable, instead of sleeping and hoping. Deterministic, no flaky timers.
3. **Assert.** Read the state back through the public API, `GET /reservations/:id` and
   `GET /reservations` (so a malformed event that created a stray row is caught), and from
   the fake sender's delivered list. Then check:
   - each reservation matches its expected snapshot, or is absent;
   - no unexpected reservations exist;
   - delivered email count per reservation matches exactly, with nothing left pending in the outbox;
   - alert counts match (e.g. exactly one timestamp-tie alert for case 12).
   On failure it prints a readable diff and the seed.

**Two sources of scenarios, same runner:**
- **Named scenarios** (`simulator/scenarios/catalogue.ts`, one entry per catalogue row above,
  hand-written, about 15 lines each; steps can also pin the webhook's `outcome`).
  Fixed order, so expectations are exact, including email counts for order-dependent cases
  like "confirmed then cancelled". These are the ones we walk through in the interview.
- **Generated scenarios** (fuzz). The generator builds a clean history for N reservations,
  applies seeded chaos (duplicate, shuffle, drop, delay, concurrent bursts, sender
  failures), and derives `expect` with an independent oracle: final state = delivered event
  with the max `(occurredAt, eventId)`. Email expectations are invariants 2 to 4 above,
  since exact counts depend on order. Run e.g. 50 seeds per CI run.
  Plus a **permutation check**: the same delivered set, shuffled K different ways, must
  always produce the same final state.

**Same scenarios, two targets:**
- `npm run test:e2e`: Jest runs every scenario in-process (above).
- `npm run simulate -- --catalogue` (or `--scenario 4`, `--seed 42`, `--list`, `--url ...`):
  the same runner fires scenarios at a running server (`npm run start:debug`) and prints
  PASS/FAIL. It drives and reads the server through debug routes that exist only with
  `DEBUG_ENDPOINTS=1` (opt-in, so a deploy can't expose them by accident):
  `GET /debug/emails`, `POST /debug/email-failures`, `GET /debug/alerts`. Settle here means
  polling until the outbox has nothing pending, so the server's own background dispatcher
  does the sending (the real path, retries and backoff included). Because a live server keeps
  state, the runner checks emails and alerts as deltas from a baseline taken before each
  scenario. This is the live demo for the walkthrough.

**Does the harness actually catch bugs?** Checked by mutation: comparing `occurredAt` as
strings fails 7 catalogue scenarios, and re-applying equal keys (`>=` instead of `>`) fails 5.
Generated scenarios alone don't catch those two (they check final state and email counts,
not per-delivery outcomes), which is why both sources exist.

## 9. Out of scope (stated, not forgotten)

Running against a real Postgres (driver swap + docker-compose, listed as an extra), auth/HMAC signature check on the webhook, multi-instance
deployment, cancellation emails, UI. Each is listed in the README as "next steps".

## 10. Observability (metrics)

`GET /metrics` serves Prometheus text via `prom-client`, one registry per app instance (not the
global default) so tests can boot several apps in one process. Small on purpose: one series per
question an on-call person would ask.

| Metric | Type | Question it answers | Alert idea |
|---|---|---|---|
| `reservation_events_total{outcome}` | counter | What is the feed doing? `applied`, `duplicate`, `stale`, `ignored` (unknown type), `rejected` (400), `error` (500) | `error` or `rejected` rate > 0 for 5m; a jump in `stale`/`duplicate` means the source is retrying hard |
| `reservation_event_timestamp_tie_total` | counter | Did two different events share an `occurredAt`? (section 2) | any increase: page, the source's ordering can't be trusted |
| `outbox_send_total{result}` | counter | Email sends: `sent`, `failed` (will retry), `skipped` (cancelled before send), `dead_lettered` (gave up, section 4) | `failed` / (`sent` + `failed`) high: provider trouble; any `dead_lettered`: page, guests weren't told |
| `outbox_entries{status}` | gauge | Outbox size by `pending`, `sent`, `skipped`, `failed` | `pending` growing; `failed` > 0 until someone runs the bulk retry |
| `outbox_oldest_pending_age_seconds` | gauge | Is any email stuck? | > a few minutes: guests aren't getting confirmations |

Decisions:
- **Counters where things happen, gauges from the database at scrape time.** Counters are
  per process (reset on restart; `rate()` handles that). The outbox gauges are a `count(*)` and
  a `min(created_at)` on scrape, so they're true across restarts and dispatcher instances. Cost:
  two small queries per scrape (fine at outbox sizes we expect; at scale, count only `pending`).
  Age counts from `pending_since`, so an entry revived from `skipped` or requeued by the bulk
  retry reads as fresh, not as hours old.
- **The tie counter counts deliveries, not anomalies** (each redelivery of the losing event
  bumps it again, see `Alerts`). So the alert is "increased", not "equals N".
- **Labels are bounded enums only.** No `reservationId` or guest data: unbounded cardinality
  and PII. Per-reservation detail stays in the logs.
- `Alerts.counts` stays as an in-memory mirror for the simulator and tests, so they don't parse `/metrics`.
- Every label value is pre-created at 0, so dashboards show 0 instead of "no data".

Not done (next steps): a latency histogram on the webhook and on `EmailSender.send`, Node
process/default metrics (`collectDefaultMetrics`), and protecting `/metrics` from public access
(it carries no PII, but it shouldn't be on the public ingress).
