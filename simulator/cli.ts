/**
 * Fires scenarios at a running server and prints PASS/FAIL. Usage:
 *   npm run start:debug                        # in another terminal (DEBUG_ENDPOINTS=1)
 *   npm run simulate -- --list
 *   npm run simulate -- --scenario 4           # one catalogue scenario by number
 *   npm run simulate -- --catalogue            # all catalogue scenarios
 *   npm run simulate -- --seed 42              # one generated chaos scenario
 *   npm run simulate -- --url http://localhost:3000
 *
 * The server keeps state between runs. Catalogue scenarios use distinct reservation ids so they
 * can share a server; generated ones reuse ids (res-1..), so restart the server before each seed.
 */
import { generateScenario } from './generator';
import { formatResult, runScenario } from './runner';
import { Scenario } from './scenario';
import { catalogue } from './scenarios/catalogue';
import { httpTarget } from './target';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (process.argv[i + 1] ?? '');
}

async function main() {
  if (process.argv.includes('--list')) {
    for (const s of catalogue) console.log(`${String(s.catalogue).padStart(2)}  ${s.name}`);
    return;
  }

  const url = arg('url') ?? 'http://localhost:3000';
  let scenarios: Scenario[];
  if (arg('seed') !== undefined) scenarios = [generateScenario(Number(arg('seed')))];
  else if (arg('scenario') !== undefined) scenarios = catalogue.filter((s) => String(s.catalogue) === arg('scenario'));
  else scenarios = catalogue; // --catalogue (default)
  if (scenarios.length === 0) throw new Error('No matching scenario (try --list)');

  // A shared server accumulates state, so only check the reservations each scenario names.
  const target = httpTarget(url);
  let failed = 0;
  let skipped = 0;
  for (const scenario of scenarios) {
    if (scenario.inProcessOnly) {
      console.log(`SKIP  #${scenario.catalogue} ${scenario.name} (${scenario.inProcessOnly}; runs in npm test)`);
      skipped++;
      continue;
    }
    const emails = { ...scenario.expect.emails };
    for (const id of scenario.expect.timingDependentEmails ?? []) emails[id] = 'atMostOne';
    const live = { ...scenario, expect: { ...scenario.expect, emails, exhaustive: false } };
    const result = await runScenario(live, target);
    console.log(formatResult({ ...result, scenario: `${scenario.catalogue ? `#${scenario.catalogue} ` : ''}${result.scenario}` }));
    if (!result.passed) failed++;
  }
  const ran = scenarios.length - skipped;
  console.log(`\n${ran - failed}/${ran} passed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
