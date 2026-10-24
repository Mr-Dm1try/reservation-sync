import { retryDelayMs, sendDecision } from './outbox-policy';

describe('sendDecision', () => {
  it('skips a confirmation whose reservation is now cancelled', () => {
    expect(sendDecision('confirmation_email', 'cancelled')).toEqual({
      action: 'skip',
      reason: 'reservation cancelled before send',
    });
  });

  it('sends otherwise', () => {
    expect(sendDecision('confirmation_email', 'confirmed')).toEqual({ action: 'send' });
    expect(sendDecision('confirmation_email', 'pending')).toEqual({ action: 'send' });
    expect(sendDecision('some_other_kind', 'cancelled')).toEqual({ action: 'send' });
  });
});

describe('retryDelayMs', () => {
  it('doubles from 1s and caps at 5 minutes, without overflowing', () => {
    expect([1, 2, 3, 9].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 256_000]);
    for (const attempt of [10, 30, 1025, 5000]) expect(retryDelayMs(attempt)).toBe(300_000);
  });
});
