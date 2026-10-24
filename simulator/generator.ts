import { ReservationEvent } from '../src/events/reservation-event';
import { history } from './events';
import { expectationFor } from './oracle';
import { Rng } from './rng';
import { Scenario, Step } from './scenario';

export type ChaosOptions = {
  reservations: number;
  maxEventsPerReservation: number;
  dropRate: number;        // event never delivered
  duplicateRate: number;   // event delivered 2-4 times
  concurrentRate: number;  // a duplicate is fired in parallel with the original
  firstEventRaceRate: number; // a reservation's first two events are fired in parallel
  malformedRate: number;   // junk bodies sprinkled in (expect 400, no effect)
  emailFailures: number;   // max transient provider failures injected at the start
};

export const DEFAULT_CHAOS: ChaosOptions = {
  reservations: 6,
  maxEventsPerReservation: 6,
  dropRate: 0.1,
  duplicateRate: 0.3,
  concurrentRate: 0.15,
  firstEventRaceRate: 0.2,
  malformedRate: 0.05,
  emailFailures: 3,
};

const ROOM_TYPES = ['single', 'double', 'suite'] as const;

/** Clean ground truth: a realistic, correctly ordered history per reservation. */
export function cleanHistories(rng: Rng, options: ChaosOptions): ReservationEvent[][] {
  const histories: ReservationEvent[][] = [];
  for (let i = 1; i <= options.reservations; i++) {
    const id = `res-${i}`;
    const h = history(id, Date.parse('2026-03-01T10:00:00.000Z') + rng.int(0, 3_600_000));
    const events: ReservationEvent[] = [];
    const step = () => ({ stepMs: rng.int(1_000, 600_000) });

    events.push(h.next('reservation.created', { status: rng.chance(0.3) ? 'confirmed' : 'pending' }, step()));
    const updates = rng.int(0, options.maxEventsPerReservation - 2);
    for (let u = 0; u < updates; u++) {
      const last = events[events.length - 1].data.status;
      const status =
        last === 'pending' && rng.chance(0.6) ? 'confirmed'
        : last === 'confirmed' && rng.chance(0.1) ? 'pending'
        : last;
      events.push(h.next('reservation.updated', { status, roomType: rng.pick(ROOM_TYPES) }, step()));
    }
    if (rng.chance(0.3)) events.push(h.next('reservation.cancelled', {}, step()));
    histories.push(events);
  }
  return histories;
}

const MALFORMED_BODIES: unknown[] = [
  {},
  { eventId: 'junk-1', type: 'reservation.updated' },
  { eventId: 'junk-2', type: 'reservation.created', reservationId: 'junk', occurredAt: 'yesterday', data: {} },
  'not even json-shaped',
];

/**
 * Generated scenario: clean histories, then seeded chaos (drop, duplicate, shuffle, concurrent
 * duplicates, junk bodies, email provider failures). The expectation comes from the oracle,
 * so it holds for whatever order the chaos produced.
 */
export function generateScenario(seed: number, options: ChaosOptions = DEFAULT_CHAOS): Scenario {
  const rng = new Rng(seed);
  const histories = cleanHistories(rng, options);
  const ids = histories.map((h) => h[0].reservationId);

  const delivered: ReservationEvent[] = [];
  const steps: Step[] = [];
  const queue: ReservationEvent[] = [];
  for (const h of histories) {
    // Two DIFFERENT events racing to create a reservation that doesn't exist yet (section 5).
    if (h.length >= 2 && rng.chance(options.firstEventRaceRate)) {
      delivered.push(h[0], h[1]);
      steps.push({ sendConcurrently: rng.shuffle([h[0], h[1]]) });
      queue.push(...h.slice(2));
    } else {
      queue.push(...h);
    }
  }
  for (const event of queue) {
    if (rng.chance(options.dropRate)) continue;
    delivered.push(event);
    if (rng.chance(options.concurrentRate)) {
      steps.push({ sendConcurrently: [event, event, ...(rng.chance(0.5) ? [event] : [])] });
      continue;
    }
    steps.push({ send: event });
    if (rng.chance(options.duplicateRate)) {
      for (let d = rng.int(1, 3); d > 0; d--) steps.push({ send: event });
    }
  }

  const shuffled = rng.shuffle(steps);
  for (let m = 0; m < Math.round(shuffled.length * options.malformedRate); m++) {
    shuffled.splice(rng.int(0, shuffled.length), 0, { sendRaw: rng.pick(MALFORMED_BODIES), status: 400 });
  }
  const failures = rng.int(0, options.emailFailures);
  if (failures > 0) shuffled.unshift({ emailSenderFails: failures });

  return {
    name: `generated seed=${seed}`,
    seed,
    steps: shuffled,
    expect: expectationFor(delivered, ids),
  };
}

/** Same delivered events, re-ordered with another seed: final state must not change. */
export function reshuffle(scenario: Scenario, seed: number): Scenario {
  const rng = new Rng(seed);
  return { ...scenario, name: `${scenario.name} reshuffled=${seed}`, steps: rng.shuffle(scenario.steps) };
}
