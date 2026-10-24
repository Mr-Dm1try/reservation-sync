/**
 * The ordering rules (DECISIONS.md, section 3), kept pure so they can be tested on their own.
 * The repository calls this while holding the reservation's row lock.
 */

export type EventKey = {
  /** Any ISO-8601 instant; compared as UTC epoch milliseconds, never as a string. */
  occurredAt: string;
  eventId: string;
};

export type StoredKey = { occurredAt: string | Date; lastEventId: string };

export type Outcome = 'applied' | 'duplicate' | 'stale';

export type Decision = {
  outcome: Outcome;
  /** Same occurredAt, different eventId: resolved by eventId, but signals a source anomaly. */
  tie: boolean;
};

export function decide(current: StoredKey | undefined, event: EventKey): Decision {
  if (!current) return { outcome: 'applied', tie: false };

  const storedMs = new Date(current.occurredAt).getTime();
  const incomingMs = new Date(event.occurredAt).getTime();

  if (incomingMs !== storedMs) {
    return { outcome: incomingMs > storedMs ? 'applied' : 'stale', tie: false };
  }
  if (event.eventId === current.lastEventId) return { outcome: 'duplicate', tie: false };
  return { outcome: event.eventId > current.lastEventId ? 'applied' : 'stale', tie: true };
}
