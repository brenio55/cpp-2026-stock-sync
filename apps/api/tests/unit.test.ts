import { describe, expect, it } from 'vitest';
import { fromCents, toCents } from '../src/common/money';
import { RateLimiter } from '../src/messaging/rate-limiter';
import { nextAction } from '../src/messaging/retry-policy';

describe('retry policy', () => {
  it('backs off along the schedule, repeats the last delay, and dead-letters at the maximum', () => {
    const delays = [5000, 30000, 120000];
    expect(nextAction(1, 5, delays)).toEqual({ type: 'retry', delayMs: 5000 });
    expect(nextAction(2, 5, delays)).toEqual({ type: 'retry', delayMs: 30000 });
    expect(nextAction(3, 5, delays)).toEqual({ type: 'retry', delayMs: 120000 });
    expect(nextAction(4, 5, delays)).toEqual({ type: 'retry', delayMs: 120000 });
    expect(nextAction(5, 5, delays)).toEqual({ type: 'dead' });
    expect(nextAction(9, 5, delays)).toEqual({ type: 'dead' });
  });
});

describe('rate limiter', () => {
  it('never lets more than 5 requests start inside any one-second window', async () => {
    let clock = 0;
    const limiter = new RateLimiter(5, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    const starts: number[] = [];
    for (let i = 0; i < 40; i++) {
      await limiter.acquire();
      starts.push(clock);
    }
    for (let i = 0; i + 5 < starts.length; i++) {
      // the 6th request after any request must be at least 1000ms later
      expect(starts[i + 5]! - starts[i]!).toBeGreaterThanOrEqual(1000);
    }
  });

  it('reserves slots synchronously, so concurrent callers are spaced out too', async () => {
    const clock = 0; // every caller reads the same instant; the reserved slots must still differ
    const waits: number[] = [];
    const limiter = new RateLimiter(5, { now: () => clock, sleep: async (ms) => void waits.push(ms) });
    await Promise.all(Array.from({ length: 4 }, () => limiter.acquire()));
    expect(waits).toHaveLength(3); // the first call is free
    expect(waits[0]).toBeLessThan(waits[1]!);
    expect(waits[1]).toBeLessThan(waits[2]!);
  });
});

describe('money', () => {
  it('does exact decimal arithmetic via cents', () => {
    expect(fromCents(toCents('19.99') * 3n + toCents('0.10') * 3n)).toBe('60.27');
    expect(fromCents(toCents('0.10') + toCents('0.20'))).toBe('0.30'); // 0.1 + 0.2 !== 0.3 with floats
    expect(toCents('5')).toBe(500n);
    expect(fromCents(5n)).toBe('0.05');
  });
});
