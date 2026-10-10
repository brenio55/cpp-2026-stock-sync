const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Smooth outbound rate limiter (a token bucket of capacity 1): requests are spaced at least
 * 1000/rate ms apart, so no sliding one-second window can ever contain more than `rate` requests.
 * A burst-capable bucket (capacity = rate) would allow 5 requests at the end of one second and 5 at the
 * start of the next, which a fixed-window server would reject.
 *
 * Slots are reserved synchronously, so concurrent callers queue up correctly.
 * `now` and `sleep` are injectable so tests run on a fake clock.
 */
export class RateLimiter {
  private nextSlot = 0;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    ratePerSecond: number,
    opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; safetyMarginMs?: number } = {},
  ) {
    this.intervalMs = 1000 / ratePerSecond + (opts.safetyMarginMs ?? 10);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  async acquire(): Promise<void> {
    const now = this.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.intervalMs;
    const wait = slot - now;
    if (wait > 0) await this.sleep(wait);
  }
}
