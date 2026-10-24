import { history, withData } from '../events';
import { Scenario } from '../scenario';

/**
 * Hand-written scenarios, one per row of the chaos catalogue in docs/DECISIONS.md (section 8).
 * Fixed delivery order, so expectations are exact. `outcome` on a step pins what the webhook
 * should answer for that delivery.
 */
export const catalogue: Scenario[] = [
  (() => {
    const r = history('r01');
    const created = r.next('reservation.created');
    const confirmed = r.next('reservation.updated', { status: 'confirmed' });
    return {
      catalogue: 1,
      name: 'exact duplicate is a no-op',
      steps: [
        { send: created, outcome: 'applied' },
        { send: confirmed, outcome: 'applied' },
        { send: created, outcome: 'stale' },
        { send: confirmed, outcome: 'duplicate' },
      ],
      expect: { reservations: { r01: { status: 'confirmed', lastEventId: 'r01-e2' } }, emails: { r01: 1 } },
    };
  })(),

  (() => {
    const created = history('r02').next('reservation.created', { status: 'confirmed' });
    return {
      catalogue: 2,
      name: 'same event delivered 5 times concurrently',
      steps: [{ sendConcurrently: [created, created, created, created, created] }],
      expect: { reservations: { r02: { status: 'confirmed', lastEventId: 'r02-e1' } }, emails: { r02: 1 } },
    };
  })(),

  (() => {
    const r = history('r03');
    const created = r.next('reservation.created');
    const updated = r.next('reservation.updated', { roomType: 'suite' });
    return {
      catalogue: 3,
      name: 'update arrives before create',
      steps: [
        { send: updated, outcome: 'applied' },
        { send: created, outcome: 'stale' },
      ],
      expect: { reservations: { r03: { status: 'pending', roomType: 'suite', lastEventId: 'r03-e2' } }, emails: {} },
    };
  })(),

  (() => {
    const r = history('r04');
    const created = r.next('reservation.created', { status: 'confirmed' });
    const updated = r.next('reservation.updated', { roomType: 'suite' });
    const cancelled = r.next('reservation.cancelled');
    return {
      catalogue: 4,
      name: 'late update cannot resurrect a cancelled reservation',
      steps: [
        { send: created, outcome: 'applied' },
        { send: cancelled, outcome: 'applied' },
        { send: updated, outcome: 'stale' },
      ],
      // The confirmation was queued, but the cancel is applied before the dispatcher runs, so the
      // entry is skipped: we don't confirm a booking the guest no longer has (DECISIONS section 4).
      expect: { reservations: { r04: { status: 'cancelled', lastEventId: 'r04-e3' } }, emails: { r04: 0 }, timingDependentEmails: ['r04'] },
    };
  })(),

  (() => {
    const r = history('r05');
    const created = r.next('reservation.created');
    r.next('reservation.updated', { roomType: 'single' }); // lost
    const confirmed = r.next('reservation.updated', { status: 'confirmed' });
    return {
      catalogue: 5,
      name: 'gap: a middle event is never delivered',
      steps: [{ send: created }, { send: confirmed, outcome: 'applied' }],
      expect: {
        reservations: { r05: { status: 'confirmed', roomType: 'single', lastEventId: 'r05-e3' } },
        emails: { r05: 1 },
      },
    };
  })(),

  (() => {
    const r = history('r06');
    r.next('reservation.created'); // lost
    const confirmed = r.next('reservation.updated', { status: 'confirmed' });
    return {
      catalogue: 6,
      name: 'lost "created": first delivery is an update',
      steps: [{ send: confirmed, outcome: 'applied' }],
      expect: { reservations: { r06: { status: 'confirmed', lastEventId: 'r06-e2' } }, emails: { r06: 1 } },
    };
  })(),

  (() => {
    const r = history('r07');
    const created = r.next('reservation.created');
    const confirmed = r.next('reservation.updated', { status: 'confirmed' });
    const updated = r.next('reservation.updated', { roomType: 'suite' });
    return {
      catalogue: 7,
      name: 'very late replay of the first event',
      steps: [{ send: created }, { send: confirmed }, { send: updated }, { send: created, outcome: 'stale' }],
      expect: {
        reservations: { r07: { status: 'confirmed', roomType: 'suite', lastEventId: 'r07-e3' } },
        emails: { r07: 1 },
      },
    };
  })(),

  (() => {
    const r = history('r08');
    const created = r.next('reservation.created');
    const confirmed = r.next('reservation.updated', { status: 'confirmed' });
    return {
      catalogue: 8,
      name: 'confirmation delivered many times, sequentially and concurrently',
      steps: [
        { send: created },
        { send: confirmed, outcome: 'applied' },
        { send: confirmed, outcome: 'duplicate' },
        { sendConcurrently: [confirmed, confirmed, confirmed] },
        { send: confirmed, outcome: 'duplicate' },
      ],
      expect: { reservations: { r08: { status: 'confirmed' } }, emails: { r08: 1 } },
    };
  })(),

  (() => {
    const created = history('r09').next('reservation.created', { status: 'confirmed' });
    return {
      catalogue: 9,
      name: 'created already confirmed',
      steps: [{ send: created, outcome: 'applied' }],
      expect: { reservations: { r09: { status: 'confirmed' } }, emails: { r09: 1 } },
    };
  })(),

  (() => {
    const r = history('r10');
    const events = [
      r.next('reservation.created'),
      r.next('reservation.updated', { status: 'confirmed' }),
      r.next('reservation.updated', { status: 'pending' }),
      r.next('reservation.updated', { status: 'confirmed' }),
    ];
    return {
      catalogue: 10,
      name: 'confirm, unconfirm, reconfirm: still one email',
      steps: events.map((send) => ({ send, outcome: 'applied' as const })),
      expect: { reservations: { r10: { status: 'confirmed', lastEventId: 'r10-e4' } }, emails: { r10: 1 } },
    };
  })(),

  (() => {
    const r = history('r11');
    const created = r.next('reservation.created');
    const confirmed = r.next('reservation.updated', { status: 'confirmed' });
    const cancelled = r.next('reservation.cancelled');
    return {
      catalogue: 11,
      name: 'cancel arrives before confirm: no email',
      steps: [{ send: created }, { send: cancelled }, { send: confirmed, outcome: 'stale' }],
      expect: { reservations: { r11: { status: 'cancelled', lastEventId: 'r11-e3' } }, emails: {} },
    };
  })(),

  ...(['b-then-a', 'a-then-b'] as const).map((order): Scenario => {
    const id = order === 'b-then-a' ? 'r12x' : 'r12y'; // distinct ids so both can share a server
    const r = history(id);
    const created = r.next('reservation.created');
    const at = '2026-03-01T10:05:00.000Z';
    const a = r.next('reservation.updated', { roomType: 'single' }, { occurredAt: at, eventId: `${id}-a` });
    const b = r.next('reservation.updated', { roomType: 'suite' }, { occurredAt: at, eventId: `${id}-b` });
    const [first, second] = order === 'b-then-a' ? [b, a] : [a, b];
    return {
      catalogue: 12,
      name: `same occurredAt, different eventId (${order}): same winner, one alert`,
      steps: [
        { send: created },
        { send: first, outcome: 'applied' },
        { send: second, outcome: order === 'b-then-a' ? 'stale' : 'applied' },
      ],
      expect: {
        reservations: { [id]: { roomType: 'suite', lastEventId: `${id}-b` } },
        emails: {},
        alerts: { timestampTie: 1 },
      },
    };
  }),

  (() => {
    const r = history('r13');
    const created = r.next('reservation.created');
    const confirmed = r.next('reservation.updated', { status: 'confirmed' });
    const tampered = withData(confirmed, { roomType: 'suite' });
    return {
      catalogue: 13,
      name: 'same eventId, different payload: first one kept',
      steps: [{ send: created }, { send: confirmed }, { send: tampered, outcome: 'duplicate' }],
      expect: { reservations: { r13: { status: 'confirmed', roomType: 'double' } }, emails: { r13: 1 } },
    };
  })(),

  (() => {
    const valid = history('r14').next('reservation.created');
    return {
      catalogue: 14,
      name: 'malformed bodies are rejected and change nothing',
      steps: [
        { sendRaw: {}, status: 400 },
        { sendRaw: { ...valid, occurredAt: 'yesterday' }, status: 400 },
        { sendRaw: { ...valid, data: { ...valid.data, guest: { name: 'x', email: 'not-an-email' } } }, status: 400 },
        { sendRaw: { ...valid, type: 'reservation.updated', data: undefined }, status: 400 },
      ],
      expect: { reservations: { r14: 'absent' }, emails: {} },
    };
  })(),

  {
    catalogue: 15,
    name: 'unknown event type is acknowledged and ignored',
    steps: [
      {
        sendRaw: { eventId: 'r15-e1', type: 'reservation.no_show', reservationId: 'r15', occurredAt: '2026-03-01T10:00:00Z' },
        status: 200,
        outcome: 'ignored',
      },
    ],
    expect: { reservations: { r15: 'absent' }, emails: {} },
  },

  (() => {
    const r = history('r16');
    const created = r.next('reservation.created', {}, { occurredAt: '2026-03-01T10:00:00Z' });
    // 12:01 at +02:00 is 10:01 UTC: later than `created`.
    const confirmed = r.next('reservation.updated', { status: 'confirmed' }, { occurredAt: '2026-03-01T12:01:00+02:00' });
    // 11:59 at +02:00 is 09:59 UTC: OLDER than `created`, although it sorts later as a string.
    const old = r.next('reservation.updated', { roomType: 'suite' }, { occurredAt: '2026-03-01T11:59:00+02:00', eventId: 'r16-old' });
    return {
      catalogue: 16,
      name: 'mixed timestamp formats compare by instant, not by string',
      steps: [
        { send: created, outcome: 'applied' },
        { send: confirmed, outcome: 'applied' },
        { send: old, outcome: 'stale' },
        // Redelivery of `confirmed`, same instant written in UTC with milliseconds.
        { send: { ...confirmed, occurredAt: '2026-03-01T10:01:00.000Z' }, outcome: 'duplicate' },
      ],
      expect: {
        reservations: { r16: { status: 'confirmed', roomType: 'double', lastEventId: 'r16-e2' } },
        emails: { r16: 1 },
      },
    };
  })(),

  (() => {
    const histories = ['r17a', 'r17b', 'r17c'].map((id) => {
      const r = history(id);
      return [
        r.next('reservation.created'),
        r.next('reservation.updated', { status: 'confirmed' }),
        id === 'r17c' ? r.next('reservation.cancelled') : r.next('reservation.updated', { roomType: 'suite' }),
      ];
    });
    const [a, b, c] = histories;
    // Interleaved across reservations, and partly reversed within each one.
    const order = [a[0], b[2], c[1], a[2], b[0], c[0], a[1], c[2], b[1]];
    return {
      catalogue: 17,
      name: 'many reservations interleaved',
      steps: order.map((send) => ({ send })),
      expect: {
        reservations: {
          r17a: { status: 'confirmed', roomType: 'suite', lastEventId: 'r17a-e3' },
          r17b: { status: 'confirmed', roomType: 'suite', lastEventId: 'r17b-e3' },
          r17c: { status: 'cancelled', lastEventId: 'r17c-e3' },
        },
        // r17a: e3 applied (confirmed) -> email. r17b: e3 first (confirmed) -> email.
        // r17c: e2 (confirmed) queues an email, but e3 (cancel) is applied before the dispatcher
        // runs, so it's skipped (DECISIONS section 4).
        emails: { r17a: 1, r17b: 1, r17c: 0 },
        timingDependentEmails: ['r17c'],
      },
    };
  })(),

  (() => {
    const x = history('r18a').next('reservation.created', { status: 'confirmed' });
    const y = history('r18b').next('reservation.created', { status: 'confirmed' });
    return {
      catalogue: 18,
      name: 'email provider fails transiently: retried, still one email each',
      steps: [{ emailSenderFails: 3 }, { send: x }, { send: y }, { send: x, outcome: 'duplicate' }],
      expect: {
        reservations: { r18a: { status: 'confirmed' }, r18b: { status: 'confirmed' } },
        emails: { r18a: 1, r18b: 1 },
      },
    };
  })(),

  (() => {
    const r = history('r19');
    const created = r.next('reservation.created');
    const confirmed = r.next('reservation.updated', { status: 'confirmed' });
    // DECISIONS section 5: the hard race. Both find no row; the primary key lets one insert,
    // the other must fall through to SELECT ... FOR UPDATE and compare keys.
    return {
      catalogue: 19,
      name: 'two different first events race to create the reservation',
      steps: [{ sendConcurrently: [confirmed, created, confirmed, created] }],
      expect: { reservations: { r19: { status: 'confirmed', lastEventId: 'r19-e2' } }, emails: { r19: 1 } },
    };
  })(),

  (() => {
    const r = history('r20');
    const created = r.next('reservation.created', { status: 'confirmed' });
    const cancelled = r.next('reservation.cancelled');
    const reinstated = r.next('reservation.updated', { status: 'confirmed', roomType: 'suite' });
    // DECISIONS section 3: the source is the system of record, so a NEWER snapshot may un-cancel.
    // Only an older one can't. Still one confirmation email in total (section 4).
    return {
      catalogue: 20,
      name: 'a newer snapshot that un-cancels is honoured',
      steps: [
        { send: created, outcome: 'applied' },
        { send: cancelled, outcome: 'applied' },
        { send: reinstated, outcome: 'applied' },
        { send: cancelled, outcome: 'stale' },
      ],
      expect: {
        reservations: { r20: { status: 'confirmed', roomType: 'suite', lastEventId: 'r20-e3' } },
        emails: { r20: 1 },
      },
    };
  })(),

  (() => {
    const x = history('r21').next('reservation.created', { status: 'confirmed' });
    // DECISIONS section 4: the give-up rule is a time window (2h), not an attempt count, so a long
    // outage inside the window is just more retries. No alert, still exactly one email.
    return {
      catalogue: 21,
      name: 'long email provider outage inside the retry window: still one email, no alert',
      inProcessOnly: 'about an hour of real backoff on a live server',
      steps: [{ emailSenderFails: 30 }, { send: x }, { send: x, outcome: 'duplicate' }],
      expect: { reservations: { r21: { status: 'confirmed' } }, emails: { r21: 1 } },
    };
  })(),

  (() => {
    const x = history('r22a').next('reservation.created', { status: 'confirmed' });
    const y = history('r22b').next('reservation.created', { status: 'confirmed' });
    // DECISIONS section 4: past the window the entry is dead-lettered ('failed') and alerted.
    // Redeliveries don't revive it; only the operator's bulk retry does, and it sends once.
    return {
      catalogue: 22,
      name: 'outage outlasts the retry window: dead-lettered, alerted, bulk retry sends once',
      app: { outboxRetryWindowMs: 0 }, // any failure is already past the window
      inProcessOnly: 'needs a server started with a zero retry window',
      steps: [
        { emailSenderFails: 1 },
        { send: x },
        { drainOutbox: true },
        { send: y },
        { send: x, outcome: 'duplicate' },
        { drainOutbox: true },
        { retryFailedEmails: true, requeued: 1 },
        { retryFailedEmails: true, requeued: 0 },
      ],
      expect: {
        reservations: { r22a: { status: 'confirmed' }, r22b: { status: 'confirmed' } },
        emails: { r22a: 1, r22b: 1 },
        alerts: { outboxDeadLettered: 1 },
      },
    };
  })(),
];
