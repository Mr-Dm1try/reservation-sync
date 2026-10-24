import { decide, StoredKey } from './decide';

const stored: StoredKey = { occurredAt: '2026-01-01T10:00:00.000Z', lastEventId: 'e-m' };

describe('decide', () => {
  it('applies the first event for a reservation', () => {
    expect(decide(undefined, { occurredAt: '2026-01-01T10:00:00Z', eventId: 'e1' })).toEqual({
      outcome: 'applied',
      tie: false,
    });
  });

  it('applies a strictly newer event, even with a smaller eventId', () => {
    expect(decide(stored, { occurredAt: '2026-01-01T10:00:00.001Z', eventId: 'e-a' })).toEqual({
      outcome: 'applied',
      tie: false,
    });
  });

  it('marks an older event stale, even with a greater eventId', () => {
    expect(decide(stored, { occurredAt: '2026-01-01T09:59:59.999Z', eventId: 'e-z' })).toEqual({
      outcome: 'stale',
      tie: false,
    });
  });

  it('treats a redelivery of the latest applied event as a duplicate', () => {
    expect(decide(stored, { occurredAt: stored.occurredAt as string, eventId: 'e-m' })).toEqual({
      outcome: 'duplicate',
      tie: false,
    });
  });

  it('compares instants, not strings: offsets and missing ms are the same instant', () => {
    for (const occurredAt of ['2026-01-01T10:00:00Z', '2026-01-01T12:00:00+02:00', '2026-01-01T05:00:00.000-05:00']) {
      expect(decide(stored, { occurredAt, eventId: 'e-m' })).toEqual({ outcome: 'duplicate', tie: false });
    }
    // A string comparison would call this older ("09" < "10"); as an instant it is 1 ms newer.
    expect(decide(stored, { occurredAt: '2026-01-01T09:00:00.001-01:00', eventId: 'e-a' }).outcome).toBe('applied');
  });

  it('accepts a Date for the stored key (as read back from timestamptz)', () => {
    const fromDb = { occurredAt: new Date('2026-01-01T10:00:00.000Z'), lastEventId: 'e-m' };
    expect(decide(fromDb, { occurredAt: '2026-01-01T10:00:00Z', eventId: 'e-m' }).outcome).toBe('duplicate');
  });

  describe('same occurredAt, different eventId', () => {
    it('flags a tie and lets the greater eventId win', () => {
      expect(decide(stored, { occurredAt: '2026-01-01T10:00:00Z', eventId: 'e-z' })).toEqual({
        outcome: 'applied',
        tie: true,
      });
      expect(decide(stored, { occurredAt: '2026-01-01T10:00:00Z', eventId: 'e-a' })).toEqual({
        outcome: 'stale',
        tie: true,
      });
    });

    it('picks the same winner whichever event arrives first', () => {
      const a = { occurredAt: '2026-01-01T10:00:00.000Z', eventId: 'e-a' };
      const b = { occurredAt: '2026-01-01T12:00:00+02:00', eventId: 'e-b' };
      const winner = (first: typeof a, second: typeof a) =>
        decide({ occurredAt: first.occurredAt, lastEventId: first.eventId }, second).outcome === 'applied'
          ? second.eventId
          : first.eventId;
      expect(winner(a, b)).toBe('e-b');
      expect(winner(b, a)).toBe('e-b');
    });
  });
});
