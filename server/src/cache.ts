/**
 * SQLite-backed read-through TTL cache.
 *
 * Values are stored as JSON in a single table so cached responses survive
 * process restarts (use a file dbPath in production; ':memory:' in tests).
 * Expired rows are deleted lazily on read — no background timers.
 *
 * Concurrent getOrFetch calls for the same key may each call fn (no in-flight
 * dedup); the rate-limit queue in front of the upstream bounds the cost.
 */

import Database from 'better-sqlite3';

export interface CacheOptions {
  /** SQLite database path, or ':memory:' for a non-persistent cache. */
  dbPath: string;
  /** Time-to-live per entry in milliseconds. Default 300 000 (5 min). */
  ttlMs?: number;
  /** Clock returning ms since epoch. Injectable for deterministic tests. */
  now?: () => number;
}

export interface Cache {
  /**
   * Returns the cached value for key if present and unexpired; otherwise
   * awaits fn(), stores its result, and returns it. Rejections from fn
   * propagate and are never cached.
   */
  getOrFetch<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Removes all entries. */
  clear(): void;
  /** Closes the underlying database. The cache is unusable afterwards. */
  close(): void;
}

export function createCache(options: CacheOptions): Cache {
  const { dbPath, ttlMs = 300_000, now = Date.now } = options;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`Invalid ttlMs: ${ttlMs} (expected a positive number)`);
  }

  const db = new Database(dbPath);
  db.exec(
    `CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expiresAt INTEGER NOT NULL
    )`,
  );

  const selectStmt = db.prepare<[string], { value: string; expiresAt: number }>(
    'SELECT value, expiresAt FROM cache WHERE key = ?',
  );
  const upsertStmt = db.prepare<[string, string, number]>(
    `INSERT INTO cache (key, value, expiresAt) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expiresAt = excluded.expiresAt`,
  );
  const deleteStmt = db.prepare<[string]>('DELETE FROM cache WHERE key = ?');

  return {
    async getOrFetch<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const row = selectStmt.get(key);
      if (row !== undefined) {
        if (row.expiresAt > now()) {
          // A corrupted row throws here uncaught; out of scope to recover from.
          return JSON.parse(row.value) as T;
        }
        deleteStmt.run(key); // lazy eviction of the expired row
      }

      const value = await fn();
      upsertStmt.run(key, JSON.stringify(value), now() + ttlMs);
      return value;
    },

    clear(): void {
      db.exec('DELETE FROM cache');
    },

    close(): void {
      db.close();
    },
  };
}
