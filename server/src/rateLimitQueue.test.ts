import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimitQueue } from './rateLimitQueue.js';

describe('createRateLimitQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes immediately when under budget', async () => {
    const queue = createRateLimitQueue({ limit: 3 });

    // Resolves without any timer advancing — no artificial delay.
    await expect(queue.run(async () => 'a')).resolves.toBe('a');
    await expect(queue.run(async () => 'b')).resolves.toBe('b');
    expect(queue.waiting).toBe(0);
  });

  it('waits when budget is exhausted and executes when the oldest call leaves the window', async () => {
    const queue = createRateLimitQueue({ limit: 2, windowMs: 60_000 });

    const first = queue.run(async () => 'first'); // starts at t=0
    await vi.advanceTimersByTimeAsync(10_000);
    const second = queue.run(async () => 'second'); // starts at t=10_000

    let started = false;
    const third = queue.run(async () => {
      started = true;
      return 'third';
    });

    // Still inside the window of the oldest (t=0) call.
    await vi.advanceTimersByTimeAsync(49_999); // t=59_999
    expect(started).toBe(false);
    expect(queue.waiting).toBe(1);

    // Oldest call leaves the window at t=60_000, not t=70_000 (sliding window).
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(true);
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    await expect(third).resolves.toBe('third');
    expect(queue.waiting).toBe(0);
  });

  it('preserves FIFO order for waiting calls', async () => {
    const queue = createRateLimitQueue({ limit: 1, windowMs: 60_000 });
    const order: string[] = [];
    const track = (name: string) => () => {
      order.push(name);
      return Promise.resolve(name);
    };

    const all = Promise.all([
      queue.run(track('a')),
      queue.run(track('b')),
      queue.run(track('c')),
    ]);

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(order).toEqual(['a', 'b', 'c']);
    await expect(all).resolves.toEqual(['a', 'b', 'c']);
  });

  it('never rejects calls because of the limit', async () => {
    const queue = createRateLimitQueue({ limit: 2, windowMs: 60_000 });

    const results = Promise.all(
      Array.from({ length: 10 }, (_, i) => queue.run(async () => i)),
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await expect(results).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('defaults to a budget of 14 per 60s window', async () => {
    const queue = createRateLimitQueue();
    let overBudgetStarted = false;

    const runs: Array<Promise<unknown>> = [];
    for (let i = 0; i < 14; i += 1) {
      runs.push(queue.run(async () => i));
    }
    runs.push(
      queue.run(async () => {
        overBudgetStarted = true;
      }),
    );

    await vi.advanceTimersByTimeAsync(59_999);
    expect(overBudgetStarted).toBe(false);
    expect(queue.waiting).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(overBudgetStarted).toBe(true);
    expect(queue.waiting).toBe(0);
    await Promise.all(runs);
  });

  it('propagates errors, counts the failed call against the window, and does not wedge the queue', async () => {
    const queue = createRateLimitQueue({ limit: 1, windowMs: 60_000 });

    const failing = queue.run(async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');

    let started = false;
    const next = queue.run(async () => {
      started = true;
      return 'ok';
    });

    // The failed request was still made upstream, so it occupies the window.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toBe('ok');
  });

  it('drains a burst of limit + 3 calls in FIFO order across window boundaries', async () => {
    const limit = 2;
    const queue = createRateLimitQueue({ limit, windowMs: 60_000 });
    const t0 = Date.now();
    const starts: Array<{ name: number; at: number }> = [];

    const all = Promise.all(
      Array.from({ length: limit + 3 }, (_, i) =>
        queue.run(async () => {
          starts.push({ name: i, at: Date.now() - t0 });
          return i;
        }),
      ),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([
      { name: 0, at: 0 },
      { name: 1, at: 0 },
    ]);
    expect(queue.waiting).toBe(3);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts.slice(2)).toEqual([
      { name: 2, at: 60_000 },
      { name: 3, at: 60_000 },
    ]);
    expect(queue.waiting).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(starts.slice(4)).toEqual([{ name: 4, at: 120_000 }]);
    await expect(all).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(queue.waiting).toBe(0);
  });

  it('keeps at most one pending timer no matter how many calls wait', async () => {
    const queue = createRateLimitQueue({ limit: 1, windowMs: 60_000 });

    const runs = [
      queue.run(async () => 'a'), // starts immediately, no timer
      queue.run(async () => 'b'), // waits — schedules the one timer
      queue.run(async () => 'c'), // waits — must reuse it, not stack another
    ];

    // The lazy self-rescheduling design keeps exactly one timeout alive while
    // anything waits; drain() must not add one per waiting call.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(200_000);
    await expect(Promise.all(runs)).resolves.toEqual(['a', 'b', 'c']);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Known-equivalent Stryker mutants on rateLimitQueue.ts (line 43): mutating
  // the `starts.length > 0` guard to `>= 0`/`true` is unobservable — with an
  // empty array, `starts[0] + windowMs` is NaN, so `NaN <= now` is false and
  // the prune loop exits without shifting, exactly as the guard does.
  it('rejects an invalid limit at construction time', () => {
    expect(() => createRateLimitQueue({ limit: 0 })).toThrow(/limit/);
    expect(() => createRateLimitQueue({ limit: 1.5 })).toThrow(/limit/);
  });
});
