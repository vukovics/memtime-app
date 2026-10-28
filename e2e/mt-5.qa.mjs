import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(repoRoot, "server");

const results = [];

function record(step, ok, reason) {
  results.push(ok);
  console.log(ok ? `PASS: ${step}` : `FAIL: ${step} — ${reason}`);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
}

let tmpDir = null;

try {
  tmpDir = mkdtempSync(join(tmpdir(), "mt-5-qa-"));

  // Build once; steps 1-4 import the compiled module.
  const build = run("npm", ["run", "build", "-w", "server"]);
  const buildOk = !build.error && build.status === 0;
  const buildReason = build.error
    ? build.error.message
    : `build exit code ${build.status}: ${(build.stderr || "").trim().slice(0, 200)}`;

  let cacheModule = null;
  if (buildOk) {
    try {
      cacheModule = await import(pathToFileURL(join(serverDir, "dist", "cache.js")).href);
    } catch (err) {
      cacheModule = { importError: err.message };
    }
  }

  // Step 1: read-through — fn called once, same value returned both times
  {
    const step = "getOrFetch(k) twice calls fn once and returns the same value both times";
    if (!buildOk) {
      record(step, false, buildReason);
    } else if (!cacheModule?.createCache) {
      record(step, false, `could not import compiled module: ${cacheModule?.importError}`);
    } else {
      let cache = null;
      try {
        cache = cacheModule.createCache({ dbPath: join(tmpDir, "step1.sqlite") });
        let calls = 0;
        const fn = async () => {
          calls += 1;
          return { n: 42 };
        };
        const v1 = await cache.getOrFetch("k", fn);
        const v2 = await cache.getOrFetch("k", fn);
        if (calls !== 1) record(step, false, `fn called ${calls} times, expected 1`);
        else if (JSON.stringify(v1) !== JSON.stringify(v2)) record(step, false, "values differ between calls");
        else record(step, true);
      } catch (err) {
        record(step, false, err.message);
      } finally {
        cache?.close();
      }
    }
  }

  // Step 2: distinct keys are cached independently
  {
    const step = 'distinct keys "k?limit=10" and "k?limit=20" each call fn once (2 total)';
    if (!buildOk) {
      record(step, false, buildReason);
    } else if (!cacheModule?.createCache) {
      record(step, false, `could not import compiled module: ${cacheModule?.importError}`);
    } else {
      let cache = null;
      try {
        cache = cacheModule.createCache({ dbPath: join(tmpDir, "step2.sqlite") });
        let calls = 0;
        const fn = async () => {
          calls += 1;
          return calls;
        };
        await cache.getOrFetch("k?limit=10", fn);
        await cache.getOrFetch("k?limit=10", fn);
        await cache.getOrFetch("k?limit=20", fn);
        await cache.getOrFetch("k?limit=20", fn);
        if (calls !== 2) record(step, false, `fn called ${calls} times total, expected 2`);
        else record(step, true);
      } catch (err) {
        record(step, false, err.message);
      } finally {
        cache?.close();
      }
    }
  }

  // Step 3: expiry — advancing an injected clock past ttlMs triggers a refetch
  {
    const step = "entry expires after ttlMs (injected now) and fn is called again";
    if (!buildOk) {
      record(step, false, buildReason);
    } else if (!cacheModule?.createCache) {
      record(step, false, `could not import compiled module: ${cacheModule?.importError}`);
    } else {
      let cache = null;
      try {
        let currentTime = 1_000_000;
        const ttlMs = 1_000;
        cache = cacheModule.createCache({
          dbPath: join(tmpDir, "step3.sqlite"),
          ttlMs,
          now: () => currentTime,
        });
        let calls = 0;
        const fn = async () => {
          calls += 1;
          return calls;
        };
        await cache.getOrFetch("k", fn);
        await cache.getOrFetch("k", fn); // still fresh
        currentTime += ttlMs + 1; // advance past expiry
        await cache.getOrFetch("k", fn);
        if (calls !== 2) record(step, false, `fn called ${calls} times, expected 2 (1 before + 1 after expiry)`);
        else record(step, true);
      } catch (err) {
        record(step, false, err.message);
      } finally {
        cache?.close();
      }
    }
  }

  // Step 4: persistence across restarts — close, reopen same file, cached value survives
  {
    const step = "value persists across close()+reopen on the same file without calling fn";
    if (!buildOk) {
      record(step, false, buildReason);
    } else if (!cacheModule?.createCache) {
      record(step, false, `could not import compiled module: ${cacheModule?.importError}`);
    } else {
      const dbPath = join(tmpDir, "step4.sqlite");
      let cacheA = null;
      let cacheB = null;
      try {
        cacheA = cacheModule.createCache({ dbPath });
        const seeded = await cacheA.getOrFetch("k", async () => ({ value: "persisted" }));
        cacheA.close();
        cacheA = null;

        cacheB = cacheModule.createCache({ dbPath });
        const throwingFn = async () => {
          throw new Error("fn should not be called — value must come from the persisted file");
        };
        const reloaded = await cacheB.getOrFetch("k", throwingFn);
        if (JSON.stringify(reloaded) !== JSON.stringify(seeded)) {
          record(step, false, `reloaded value ${JSON.stringify(reloaded)} !== seeded ${JSON.stringify(seeded)}`);
        } else {
          record(step, true);
        }
      } catch (err) {
        record(step, false, err.message);
      } finally {
        cacheA?.close();
        cacheB?.close();
      }
    }
  }

  // Step 5: unit suite green
  {
    const step = "unit test suite passes (npm test -w server)";
    const test = run("npm", ["test", "-w", "server"]);
    if (test.error) {
      record(step, false, test.error.message);
    } else if (test.status !== 0) {
      record(step, false, `exit code ${test.status}: ${(test.stderr || test.stdout || "").trim().slice(0, 300)}`);
    } else {
      record(step, true);
    }
  }
} finally {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

const passed = results.filter(Boolean).length;
console.log(`MT-5 QA: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
