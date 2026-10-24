import { createApp } from './app';
import { createDb } from './db/create-db';

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  // DATABASE_URL set = real Postgres. Otherwise PGlite; PGLITE_DATA_DIR unset = in-memory (state is lost on restart).
  const { db, kind } = await createDb({ databaseUrl: process.env.DATABASE_URL, pgliteDataDir: process.env.PGLITE_DATA_DIR });
  const { app } = await createApp({ db });
  await app.listen(port);
  console.log(`reservation-sync listening on http://localhost:${port} (database: ${kind})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
