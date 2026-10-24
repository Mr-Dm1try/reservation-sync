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
npm run test:e2e
```

## Layout

```
src/
  app.ts                  composition root: createApp(), used by main, tests and simulator
  events/                 event schema (zod) and types: the contract with the source
  db/                     Db port, PGlite adapter, schema (reservations_last_event, outbox)
  reservations/           webhook + read API, decide(), repository
  outbox/                 dispatcher: sends pending emails with retries
  email/                  EmailSender port + FakeEmailSender (simulated provider)
  observability/alerts.ts "should never happen" signals (e.g. timestamp ties)
simulator/                scenarios, generator, e2e runner, CLI
test/                     e2e tests
```

## Next steps (out of the time-box)

- Outbox dead-letter: after N failed attempts mark the entry `failed` and alert, instead of retrying
  every 5 minutes forever (backoff is capped, so attempts grow but the delay doesn't).
