import { spawnSync } from "node:child_process";
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

// Step 1: unit suite green — exhaustive FIFO/wait/no-reject/error behavior under fake timers
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

// Build once; steps 2-4 import the compiled module.
const build = run("npm", ["run", "build", "-w", "server"]);
const buildOk = !build.error && build.status === 0;
const buildReason = build.error
  ? build.error.message
  : `build exit code ${build.status}: ${(build.stderr || "").trim().slice(0, 200)}`;

let queueModule = null;
if (buildOk) {
  try {
    queueModule = await import(pathToFileURL(join(serverDir, "dist", "rateLimitQueue.js")).href);
  } catch (err) {
    queueModule = { importError: err.message };
  }
}

// Step 2: construct with defaults, run resolves, waiting drains back to 0
{
  const step = "createRateLimitQueue() constructs; run resolves fn's value; waiting is 0 after";
  if (!buildOk) {
    record(step, false, buildReason);
  } else if (!queueModule?.createRateLimitQueue) {
    record(step, false, `could not import compiled module: ${queueModule?.importError}`);
  } else {
    try {
      const queue = queueModule.createRateLimitQueue();
      const value = await queue.run(() => Promise.resolve(42));
      if (value !== 42) record(step, false, `run resolved ${JSON.stringify(value)}, expected 42`);
      else if (queue.waiting !== 0) record(step, false, `waiting is ${queue.waiting}, expected 0`);
      else record(step, true);
    } catch (err) {
      record(step, false, err.message);
    }
  }
}

// Step 3: sliding window + FIFO honored with real timers (tiny window keeps this fast)
{
  const step = "limit/windowMs honored: 3rd call of 3 (limit 2) completes ~windowMs after the 1st, FIFO order";
  if (!buildOk) {
    record(step, false, buildReason);
  } else if (!queueModule?.createRateLimitQueue) {
    record(step, false, `could not import compiled module: ${queueModule?.importError}`);
  } else {
    try {
      const windowMs = 500;
      const queue = queueModule.createRateLimitQueue({ limit: 2, windowMs });
      const start = Date.now();
      const order = [];
      const runOne = (n) =>
        queue.run(() => {
          order.push(n);
          return Promise.resolve({ n, elapsed: Date.now() - start });
        });
      const results3 = await Promise.all([runOne(1), runOne(2), runOne(3)]);
      const [r1, r2, r3] = results3;
      if (order.join(",") !== "1,2,3") {
        record(step, false, `call order was ${order.join(",")}, expected FIFO 1,2,3`);
      } else if (r1.elapsed > 100) {
        record(step, false, `call 1 took ${r1.elapsed}ms to start, expected ~immediate`);
      } else if (r2.elapsed > 100) {
        record(step, false, `call 2 took ${r2.elapsed}ms to start, expected ~immediate (within limit)`);
      } else if (r3.elapsed < windowMs - 100) {
        record(step, false, `call 3 completed at ${r3.elapsed}ms, expected >= ~${windowMs}ms`);
      } else {
        record(step, true);
      }
    } catch (err) {
      record(step, false, err.message);
    }
  }
}

// Step 4: construction validation rejects invalid limit
{
  const step = "createRateLimitQueue({ limit: 0 }) throws an error mentioning limit";
  if (!buildOk) {
    record(step, false, buildReason);
  } else if (!queueModule?.createRateLimitQueue) {
    record(step, false, `could not import compiled module: ${queueModule?.importError}`);
  } else {
    try {
      queueModule.createRateLimitQueue({ limit: 0 });
      record(step, false, "did not throw");
    } catch (err) {
      if (!/limit/i.test(err.message)) record(step, false, `error message does not mention limit: "${err.message}"`);
      else record(step, true);
    }
  }
}

const passed = results.filter(Boolean).length;
console.log(`MT-4 QA: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
