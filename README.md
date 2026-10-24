# reservation-sync

Keeps a local view of reservations in sync with an unreliable event feed (duplicates,
out-of-order, concurrent redeliveries) and sends exactly one confirmation email per
reservation. Design and trade-offs: [docs/DECISIONS.md](docs/DECISIONS.md).

Stack: TypeScript, NestJS, Postgres via [PGlite](https://pglite.dev) (in-process, no Docker), Jest.

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
  db/                     Db port, PGlite adapter, schema (reservations_last_event, outbox, events_received)
  reservations/           webhook + read API, decide(), repository
  outbox/                 dispatcher: sends pending emails with retries
  email/                  EmailSender port + FakeEmailSender (simulated provider)
  observability/          "should never happen" alerts (e.g. timestamp ties) and Prometheus metrics
simulator/                scenarios, generator, e2e runner, CLI
test/                     e2e tests
```

## Next steps (out of the time-box)

- Outbox dead-letter: after N failed attempts mark the entry `failed` and alert, instead of retrying
  every 5 minutes forever (backoff is capped, so attempts grow but the delay doesn't).
- Event log retention (bodies hold guest PII: delete after N days) and `npm run replay` from the
  log (DECISIONS.md, section 11).
