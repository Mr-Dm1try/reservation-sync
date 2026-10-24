import { Scenario, Step } from './scenario';
import { SendResult, Target } from './target';

export type ScenarioResult = {
  scenario: string;
  seed?: number;
  passed: boolean;
  failures: string[];
};

const describeStep = (step: Step, index: number): string => {
  if ('send' in step) return `step ${index} send ${step.send.eventId}`;
  if ('sendConcurrently' in step) return `step ${index} sendConcurrently ${step.sendConcurrently.map((e) => e.eventId).join(',')}`;
  if ('sendRaw' in step) return `step ${index} sendRaw`;
  return `step ${index} emailSenderFails`;
};

/** What the event log should say for one response: 400 is logged as rejected. */
const loggedOutcome = (res: SendResult): string => (res.status === 400 ? 'rejected' : (res.body?.outcome ?? `status ${res.status}`));

/**
 * Phase 1: deliver. Returns problems with individual responses (status/outcome mismatches), and
 * the outcome of every delivery, one group per step (a concurrent step's group has no order).
 */
async function deliver(target: Target, steps: Step[]): Promise<{ failures: string[]; outcomes: string[][] }> {
  const failures: string[] = [];
  const outcomes: string[][] = [];
  for (const [i, step] of steps.entries()) {
    const label = describeStep(step, i);
    if ('emailSenderFails' in step) {
      await target.failNextEmails(step.emailSenderFails);
    } else if ('sendConcurrently' in step) {
      const results = await Promise.all(step.sendConcurrently.map((e) => target.send(e)));
      outcomes.push(results.map(loggedOutcome));
      results.forEach((r, k) => r.status !== 200 && failures.push(`${label} [${k}]: status ${r.status}, expected 200`));
    } else {
      const body = 'send' in step ? step.send : step.sendRaw;
      const expectedStatus = step.status ?? 200;
      const res = await target.send(body);
      outcomes.push([loggedOutcome(res)]);
      if (res.status !== expectedStatus) failures.push(`${label}: status ${res.status}, expected ${expectedStatus}`);
      if (step.outcome && res.body?.outcome !== step.outcome) {
        failures.push(`${label}: outcome ${JSON.stringify(res.body?.outcome)}, expected "${step.outcome}"`);
      }
    }
  }
  return { failures, outcomes };
}

type Baseline = { emailsByReservation: Map<string, number>; suppressed: number; ties: number; logRows?: number };

const countByReservation = (delivered: { reservationId: string }[]) => {
  const counts = new Map<string, number>();
  for (const m of delivered) counts.set(m.reservationId, (counts.get(m.reservationId) ?? 0) + 1);
  return counts;
};

/** Counters before the scenario, so a long-running server (CLI) can be checked by deltas. */
async function baseline(target: Target): Promise<Baseline> {
  const emails = await target.emails();
  const alerts = await target.alerts();
  return {
    emailsByReservation: countByReservation(emails.delivered),
    suppressed: emails.suppressedDuplicates,
    ties: alerts.timestampTie,
    logRows: (await target.eventLog?.())?.length,
  };
}

/** Phase 3: compare what the app exposes with the expectation. */
async function verify(target: Target, scenario: Scenario, before: Baseline): Promise<string[]> {
  const { expect } = scenario;
  const failures: string[] = [];
  const views = await target.reservations();
  const byId = new Map(views.map((v) => [v.reservationId, v]));

  for (const [id, expected] of Object.entries(expect.reservations)) {
    const actual = byId.get(id);
    if (expected === 'absent') {
      if (actual) failures.push(`${id}: expected absent, found status=${actual.status} lastEventId=${actual.lastEventId}`);
      continue;
    }
    if (!actual) {
      failures.push(`${id}: missing`);
      continue;
    }
    for (const [field, value] of Object.entries(expected)) {
      const got = (actual as Record<string, unknown>)[field];
      if (JSON.stringify(got) !== JSON.stringify(value)) {
        failures.push(`${id}.${field}: got ${JSON.stringify(got)}, expected ${JSON.stringify(value)}`);
      }
    }
  }
  if (expect.exhaustive ?? true) {
    for (const id of byId.keys()) {
      if (!(id in expect.reservations)) failures.push(`${id}: unexpected reservation`);
    }
  }

  const emails = await target.emails();
  const counts = countByReservation(emails.delivered);
  const ids = new Set([
    ...Object.keys(expect.emails),
    ...Object.keys(expect.reservations),
    ...(expect.exhaustive ?? true ? counts.keys() : []),
  ]);
  for (const id of ids) {
    const got = (counts.get(id) ?? 0) - (before.emailsByReservation.get(id) ?? 0);
    const want = expect.emails[id] ?? 0;
    const ok = want === 'atMostOne' ? got <= 1 : got === want;
    if (!ok) failures.push(`${id}: ${got} confirmation email(s) delivered, expected ${want === 'atMostOne' ? 'at most 1' : want}`);
  }
  if (emails.pendingOutbox !== 0) failures.push(`outbox: ${emails.pendingOutbox} entries still pending after settle`);
  const suppressed = emails.suppressedDuplicates - before.suppressed;
  if (suppressed !== 0) failures.push(`email provider suppressed ${suppressed} duplicate send(s): the app sent twice`);

  const ties = (await target.alerts()).timestampTie - before.ties;
  const wantTies = expect.alerts?.timestampTie ?? 0;
  if (ties !== wantTies) failures.push(`alerts.timestampTie: ${ties}, expected ${wantTies}`);

  return failures;
}

/**
 * Event log invariant (DECISIONS.md, section 11): one row per delivery, and each step's rows carry
 * the outcomes its responses reported. Skipped when the target can't read the log (HTTP).
 */
async function verifyEventLog(target: Target, outcomes: string[][], before: Baseline): Promise<string[]> {
  if (!target.eventLog) return [];
  const rows = (await target.eventLog()).slice(before.logRows ?? 0);
  const sent = outcomes.flat().length;
  if (rows.length !== sent) return [`event log: ${rows.length} row(s) added, expected ${sent} (one per delivery)`];

  const failures: string[] = [];
  const sorted = (xs: string[]) => JSON.stringify([...xs].sort());
  let at = 0;
  for (const [i, group] of outcomes.entries()) {
    const logged = rows.slice(at, (at += group.length));
    if (sorted(logged) !== sorted(group)) failures.push(`event log, delivery group ${i}: logged ${sorted(logged)}, responses said ${sorted(group)}`);
  }
  return failures;
}

/** Send, settle, assert. Never throws for a mismatch: it reports everything that's wrong. */
export async function runScenario(scenario: Scenario, target: Target): Promise<ScenarioResult> {
  const before = await baseline(target);
  const { failures, outcomes } = await deliver(target, scenario.steps);
  try {
    await target.settle();
  } catch (err) {
    failures.push(`settle failed: ${(err as Error).message}`);
  }
  failures.push(...(await verify(target, scenario, before)));
  failures.push(...(await verifyEventLog(target, outcomes, before)));
  return { scenario: scenario.name, seed: scenario.seed, passed: failures.length === 0, failures };
}

export function formatResult(result: ScenarioResult): string {
  const head = `${result.passed ? 'PASS' : 'FAIL'}  ${result.scenario}`;
  return result.passed ? head : [head, ...result.failures.map((f) => `      - ${f}`)].join('\n');
}
