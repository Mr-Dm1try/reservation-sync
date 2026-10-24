import { generateScenario, reshuffle } from '../simulator/generator';
import { formatResult, runScenario } from '../simulator/runner';
import { Scenario } from '../simulator/scenario';
import { catalogue } from '../simulator/scenarios/catalogue';
import { inProcessTarget } from '../simulator/target';
import { Db } from '../src/db/db';
import { createPgliteDb } from '../src/db/pglite-db';

jest.setTimeout(30_000);

// One PGlite for the file (booting it is the slow part); each scenario gets a fresh app and
// empty tables. A failure prints every mismatch and the seed.
let db: Db;
beforeAll(async () => {
  db = await createPgliteDb();
});
afterAll(() => db.close());

async function check(scenario: Scenario) {
  const target = await inProcessTarget({ db });
  try {
    const result = await runScenario(scenario, target);
    if (!result.passed) throw new Error(formatResult(result));
  } finally {
    await target.close();
  }
}

const FUZZ_SEEDS = Number(process.env.FUZZ_SEEDS ?? 20);
const FUZZ_BASE_SEED = Number(process.env.FUZZ_BASE_SEED ?? 1);

describe('catalogue scenarios (docs/DECISIONS.md section 8)', () => {
  it.each(catalogue.map((s) => [`#${s.catalogue} ${s.name}`, s] as const))('%s', async (_name, scenario) => {
    await check(scenario);
  });
});

describe('generated chaos scenarios', () => {
  const seeds = Array.from({ length: FUZZ_SEEDS }, (_, i) => FUZZ_BASE_SEED + i);
  it.each(seeds)('seed %i', async (seed) => {
    await check(generateScenario(seed));
  });
});

describe('order independence', () => {
  it('the same deliveries in 5 different orders give the same final state', async () => {
    const base = generateScenario(4242);
    for (let k = 1; k <= 5; k++) await check(reshuffle(base, k));
  });
});
