import { createApp } from './app';

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  // PGLITE_DATA_DIR unset = in-memory database (state is lost on restart).
  const { createPgliteDb } = await import('./db/pglite-db');
  const db = await createPgliteDb(process.env.PGLITE_DATA_DIR);
  const { app } = await createApp({ db });
  await app.listen(port);
  console.log(`reservation-sync listening on http://localhost:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
