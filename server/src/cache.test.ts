import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCache, type Cache } from './cache.js';

describe('createCache', () => {
  const caches: Cache[] = [];

  /** Creates an in-memory cache with an injectable clock, tracked for cleanup. */
  function makeCache(options: { ttlMs?: number; now?: () => number } = {}): Cache {
    const cache = createCache({ dbPath: ':memory:', ...options });
    caches.push(cache);
    return cache;
  }

  afterEach(() => {
    while (caches.length > 0) {
      caches.pop()?.close();
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects ttlMs=%s at construction',
    (ttlMs) => {
      expect(() => createCache({ dbPath: ':memory:', ttlMs })).toThrow(
        `Invalid ttlMs: ${ttlMs} (expected a positive number)`,
      );
    },
  );

  it('calls fn on a miss, stores the value, and returns it', async () => {
    const cache = makeCache();
    const fn = vi.fn(async () => 'fresh');

    await expect(cache.getOrFetch('k', fn)).resolves.toBe('fresh');
    expect(fn).toHaveBeenCalledTimes(1);

    // Stored: a second read is served from the cache.
    await expect(cache.getOrFetch('k', fn)).resolves.toBe('fresh');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('serves an unexpired hit without calling fn', async () => {
    let now = 1_000;
    const cache = makeCache({ ttlMs: 300_000, now: () => now });
    const fn = vi.fn(async () => 'value');

    await cache.getOrFetch('k', fn);
    now += 299_999; // just inside the TTL
    await expect(cache.getOrFetch('k', fn)).resolves.toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL has elapsed', async () => {
    let now = 1_000;
    const cache = makeCache({ ttlMs: 300_000, now: () => now });
    let calls = 0;
    const fn = vi.fn(async () => `value-${++calls}`);

    await expect(cache.getOrFetch('k', fn)).resolves.toBe('value-1');
    now += 300_000; // exactly at expiry — entry is no longer valid
    await expect(cache.getOrFetch('k', fn)).resolves.toBe('value-2');
    expect(fn).toHaveBeenCalledTimes(2);

    // The refetched value is cached again.
    await expect(cache.getOrFetch('k', fn)).resolves.toBe('value-2');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct keys as distinct entries', async () => {
    const cache = makeCache();
    const fnA = vi.fn(async () => 'a');
    const fnB = vi.fn(async () => 'b');

    await expect(cache.getOrFetch('key-a', fnA)).resolves.toBe('a');
    await expect(cache.getOrFetch('key-b', fnB)).resolves.toBe('b');
    await expect(cache.getOrFetch('key-a', fnA)).resolves.toBe('a');
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
  });

  it('propagates fn rejection and does not cache the error', async () => {
    const cache = makeCache();
    const error = new Error('upstream failed');
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('recovered');

    await expect(cache.getOrFetch('k', fn)).rejects.toThrow('upstream failed');

    // The failure was not stored: the next call retries fn.
    await expect(cache.getOrFetch('k', fn)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('round-trips objects and arrays through JSON', async () => {
    const cache = makeCache();
    const value = {
      projects: [{ id: 1, name: 'Memtime' }, { id: 2, name: 'Other' }],
      nested: { tags: ['a', 'b'], active: true, count: null },
    };
    const fn = vi.fn(async () => value);

    await expect(cache.getOrFetch('k', fn)).resolves.toEqual(value);

    // Served from storage, not from fn or an in-memory reference.
    const cached = await cache.getOrFetch('k', fn);
    expect(cached).toEqual(value);
    expect(cached).not.toBe(value);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('persists across cache instances sharing one db file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memtime-cache-'));
    const dbPath = join(dir, 'cache.db');
    try {
      const first = createCache({ dbPath });
      const fn = vi.fn(async () => ({ id: 42 }));
      await first.getOrFetch('k', fn);
      first.close();

      // A fresh instance (as after a restart) reads the stored value.
      const second = createCache({ dbPath });
      await expect(second.getOrFetch('k', fn)).resolves.toEqual({ id: 42 });
      expect(fn).toHaveBeenCalledTimes(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes an expired row on read even when the refetch fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memtime-cache-'));
    const dbPath = join(dir, 'cache.db');
    try {
      let now = 1_000;
      const cache = createCache({ dbPath, ttlMs: 100, now: () => now });
      await cache.getOrFetch('k', async () => 'stale');
      now += 100; // entry expired

      // The expired row is evicted before fn runs; the rejection stores nothing.
      await expect(
        cache.getOrFetch('k', async () => {
          throw new Error('upstream down');
        }),
      ).rejects.toThrow('upstream down');
      cache.close();

      // Inspect the file directly: lazy eviction must have removed the row.
      const raw = new Database(dbPath);
      const { count } = raw.prepare('SELECT COUNT(*) AS count FROM cache').get() as {
        count: number;
      };
      raw.close();
      expect(count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close() closes the database, making further use fail', async () => {
    const cache = createCache({ dbPath: ':memory:' });
    await cache.getOrFetch('k', async () => 'value');
    cache.close();

    expect(() => cache.clear()).toThrow(/not open/);
    await expect(cache.getOrFetch('k', async () => 'value')).rejects.toThrow(/not open/);
  });

  it('clear() empties the cache', async () => {
    const cache = makeCache();
    const fn = vi.fn(async () => 'value');

    await cache.getOrFetch('a', fn);
    await cache.getOrFetch('b', fn);
    cache.clear();

    await cache.getOrFetch('a', fn);
    await cache.getOrFetch('b', fn);
    expect(fn).toHaveBeenCalledTimes(4);
  });
});
