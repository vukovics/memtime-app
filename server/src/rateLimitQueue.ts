/**
 * Sliding-window rate-limit queue for upstream calls.
 *
 * The upstream API allows 15 requests per 60s per API key; the default budget
 * of 14 keeps a safety margin. Calls over budget are never rejected — they
 * wait in FIFO order until the oldest counted call leaves the window.
 *
 * The window counts request START times (the upstream limiter counts requests
 * made, not completions), so a slot is consumed when a call begins and frees
 * exactly windowMs later — regardless of when, or whether, the call settles.
 */

export interface RateLimitQueueOptions {
  /** Max calls per window. Default 14 (one under the upstream limit of 15). */
  limit?: number;
  /** Window length in milliseconds. Default 60 000. */
  windowMs?: number;
}

export interface RateLimitQueue {
  /** Runs fn as soon as the budget allows; its result/error passes through. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Number of calls currently waiting for a slot (excludes in-flight calls). */
  readonly waiting: number;
}

export function createRateLimitQueue(
  options: RateLimitQueueOptions = {},
): RateLimitQueue {
  const { limit = 14, windowMs = 60_000 } = options;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid rate limit: ${limit} (expected integer >= 1)`);
  }

  /** Start timestamps of calls still inside the window (oldest first). */
  const starts: number[] = [];
  /** FIFO resolvers for calls waiting on a free slot. */
  const waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function drain(): void {
    const now = Date.now();
    while (starts.length > 0 && starts[0] + windowMs <= now) {
      starts.shift();
    }
    while (starts.length < limit) {
      const release = waiters.shift();
      if (release === undefined) break;
      starts.push(now);
      release();
    }
    if (waiters.length > 0 && timer === undefined) {
      // Waiters remain only because the loop above filled the window, so
      // starts[0] exists — and it expires strictly after `now`, or the first
      // loop would have pruned it. The delay is therefore positive.
      timer = setTimeout(() => {
        timer = undefined;
        drain();
      }, starts[0] + windowMs - now);
    }
  }

  function acquireSlot(): Promise<void> {
    return new Promise((resolve) => {
      waiters.push(resolve);
      drain();
    });
  }

  return {
    async run(fn) {
      await acquireSlot();
      return fn();
    },
    get waiting() {
      return waiters.length;
    },
  };
}
