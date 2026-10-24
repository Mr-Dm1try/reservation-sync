# reservation-sync

Keeps a local view of reservations in sync with an unreliable event feed (duplicates,
out-of-order, concurrent redeliveries) and sends exactly one confirmation email per
reservation. Design and trade-offs: [docs/DECISIONS.md](docs/DECISIONS.md).

Stack: TypeScript, NestJS, Postgres via [PGlite](https://pglite.dev) (in-process, no Docker) or a real
Postgres when `DATABASE_URL` is set, Jest.

## Run

```bash
npm install
npm start                 # http://localhost:3000, in-memory database
npm run start:debug       # same, plus the /debug routes the simulator needs (DEBUG_ENDPOINTS=1)
PGLITE_DATA_DIR=./data npm start   # persist to disk instead
npm test                  # unit + e2e
npm run test:unit
npm run test:e2e          # catalogue + 20 generated chaos seeds + reshuffles
FUZZ_SEEDS=200 npm run test:e2e   # more chaos
curl localhost:3000/metrics       # Prometheus metrics (DECISIONS.md, section 10)
curl 'localhost:3000/events?reservationId=r01'   # raw deliveries for one reservation, in received order (section 11)
```

## Real Postgres (Docker)

```bash
docker compose up --build                   # Postgres 16 + the app on :3000 (debug routes on)
npm run simulate -- --catalogue             # the catalogue against it
docker compose down -v

npm run db:up                               # only the database, on :5432 (PG_PORT to change)
npm run test:pg                             # every suite on Postgres, incl. real concurrency
DATABASE_URL=postgres://postgres:postgres@localhost:5432/reservation_sync npm start
```

PGlite runs one transaction at a time, so only Postgres really races concurrent requests
(DECISIONS.md, section 5). CI runs the suites on both.

## Simulate against a running server

```bash
npm run start:debug                         # terminal 1 (debug routes on)
npm run simulate -- --list                  # terminal 2: catalogue of messy-delivery cases
npm run simulate -- --catalogue             # run them all, PASS/FAIL per case
npm run simulate -- --scenario 16           # one case
npm run simulate -- --seed 42               # one generated chaos stream (use a fresh server)
```

## Layout

```
src/
  app.ts                  composition root: createApp(), used by main, tests and simulator
  events/                 event schema (zod) and types: the contract with the source; raw event log + GET /events
  db/                     Db port, PGlite and Postgres adapters, schema (reservations_last_event, outbox, events_received)
  reservations/           webhook + read API, decide(), repository
  outbox/                 dispatcher: sends pending emails with retries
  email/                  EmailSender port + FakeEmailSender (simulated provider)
  observability/          "should never happen" alerts (e.g. timestamp ties) and Prometheus metrics
simulator/                scenarios, generator, e2e runner, CLI
test/                     e2e tests, createTestDb() (PGlite, or Postgres if TEST_DATABASE_URL is set)
```

## Next steps (out of the time-box)

- Webhook auth: verify an HMAC signature from the PMS before parsing.
- Multi-instance: the dispatcher already claims with `SKIP LOCKED` and a lease; `drainUntilIdle`
  stays a single-instance test helper.
- Event log retention (bodies hold guest PII: delete after N days) and `npm run replay` from the
  log (DECISIONS.md, section 11).
