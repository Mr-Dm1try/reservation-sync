import { generateScenario, reshuffle } from './generator';
import { history } from './events';
import { expectationFor } from './oracle';

describe('generateScenario', () => {
  it('is reproducible from its seed', () => {
    expect(generateScenario(7)).toEqual(generateScenario(7));
    expect(generateScenario(7)).not.toEqual(generateScenario(8));
  });

  it('actually produces the messy cases it promises', () => {
    const steps = Array.from({ length: 30 }, (_, i) => generateScenario(i + 1).steps).flat();
    const sent = steps.flatMap((s) => ('send' in s ? [s.send.eventId] : []));
    expect(new Set(sent).size).toBeLessThan(sent.length); // duplicates
    expect(steps.some((s) => 'sendConcurrently' in s)).toBe(true);
    const races = steps.filter(
      (s) => 'sendConcurrently' in s && new Set(s.sendConcurrently.map((e) => e.eventId)).size > 1,
    );
    expect(races.length).toBeGreaterThan(0); // different first events of one reservation
    expect(steps.some((s) => 'sendRaw' in s)).toBe(true);
    expect(steps.some((s) => 'emailSenderFails' in s)).toBe(true);
  });

  it('reshuffle keeps the same steps and expectation', () => {
    const base = generateScenario(3);
    const other = reshuffle(base, 1);
    expect(other.expect).toEqual(base.expect);
    expect(other.steps).toHaveLength(base.steps.length);
  });
});

describe('oracle', () => {
  it('takes the max (occurredAt, eventId), compares instants not strings, and derives emails', () => {
    const r = history('o1');
    const created = r.next('reservation.created', {}, { occurredAt: '2026-03-01T10:00:00Z' });
    const confirmed = r.next('reservation.updated', { status: 'confirmed' }, { occurredAt: '2026-03-01T10:01:00Z' });
    const oldLooking = r.next('reservation.cancelled', {}, { occurredAt: '2026-03-01T11:59:00+02:00' }); // 09:59Z
    const exp = expectationFor([oldLooking, confirmed, created], ['o1', 'o2']);
    expect(exp.reservations.o1).toMatchObject({ status: 'confirmed', lastEventId: 'o1-e2' });
    expect(exp.reservations.o2).toBe('absent');
    expect(exp.emails).toEqual({ o1: 1 });
  });
});
