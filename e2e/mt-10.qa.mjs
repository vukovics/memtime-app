import { spawn, spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDir = join(repoRoot, "client");
const serverDir = join(repoRoot, "server");
const SERVER_PORT = 3000; // ng serve's proxy.conf.json targets localhost:3000 — not configurable per-run.
const CLIENT_PORT = 4200;
const CLIENT_URL = `http://localhost:${CLIENT_PORT}`;
const SERVER_HEALTH_URL = `http://localhost:${SERVER_PORT}/health`;
const SKIP_SERVE = process.env.MT10_SKIP_SERVE === "1";

const results = [];

function record(step, ok, reason) {
  results.push(ok);
  console.log(ok ? `PASS: ${step}` : `FAIL: ${step} — ${reason}`);
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd: cwd ?? repoRoot, encoding: "utf8" });
}

/** True if something is already listening on the given TCP port. */
async function isPortOpen(port) {
  try {
    const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) });
    void res;
    return true;
  } catch (err) {
    // A real HTTP response (even an error status) would have resolved above;
    // ECONNREFUSED/ECONNRESET means nothing is listening. Any other error
    // (e.g. a non-HTTP listener resetting the connection) is treated as "open"
    // to be safe.
    return !/ECONNREFUSED/.test(String(err?.cause?.code ?? err?.code ?? err));
  }
}

/** Kills a detached child by process group (POSIX: negative pid = group) and waits for exit. */
async function killGroup(child, label) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // group may already be gone
  }
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // ignore
    }
    await sleep(200);
  }
  void label;
}

let serverProc = null;
let clientProc = null;

try {
  // Step 1: unit tests (43: table/pagination/empty/retry/reload behavior matrix).
  {
    const step = "npm test -w client -- --watch=false passes (43 unit tests)";
    const test = run("npm", ["test", "-w", "client", "--", "--watch=false"]);
    if (test.error) {
      record(step, false, test.error.message);
    } else if (test.status !== 0) {
      record(step, false, `exit code ${test.status}: ${(test.stderr || test.stdout || "").trim().slice(0, 300)}`);
    } else {
      record(step, true);
    }
  }

  // Step 2: coverage gate — browse.ts and time-entries.ts must have no reported gaps (absent
  // from the per-file uncovered table, which only lists files with gaps) and a summary must
  // have printed.
  {
    const step = "ng test --coverage shows no browse.ts/time-entries.ts gaps";
    const cov = run("npx", ["ng", "test", "--coverage", "--watch=false"], clientDir);
    const out = (cov.stdout || "") + (cov.stderr || "");
    if (cov.error) {
      record(step, false, cov.error.message);
    } else if (cov.status !== 0) {
      record(step, false, `exit code ${cov.status}: ${out.trim().slice(0, 300)}`);
    } else if (!out.includes("Coverage summary")) {
      record(step, false, `no "Coverage summary" in output: ${out.trim().slice(0, 300)}`);
    } else if (out.includes("browse.ts") || out.includes("time-entries.ts")) {
      record(step, false, `browse.ts/time-entries.ts appears in the uncovered-files table: ${out.trim().slice(0, 500)}`);
    } else {
      record(step, true);
    }
  }

  // Step 3: production build.
  {
    const step = "npm run build -w client exits 0";
    const build = run("npm", ["run", "build", "-w", "client"]);
    if (build.error) {
      record(step, false, build.error.message);
    } else if (build.status !== 0) {
      record(step, false, `exit code ${build.status}: ${(build.stderr || build.stdout || "").trim().slice(0, 300)}`);
    } else {
      record(step, true);
    }
  }

  if (SKIP_SERVE) {
    console.log("serve step skipped (MT10_SKIP_SERVE=1)");
  } else {
    // Step 4: serve integration — /time-entries returns the app shell, and the page's data
    // source (the time-entries proxy route, never cached server-side) is alive.
    // [1 live upstream call]
    {
      const step = "server + ng serve up; /time-entries -> 200 app shell; /api/time-entries?limit=1 -> 200 JSON array";
      if (await isPortOpen(SERVER_PORT)) {
        record(step, false, `port ${SERVER_PORT} already in use — cannot start server for the proxy leg`);
      } else {
        const build = run("npm", ["run", "build", "-w", "server"]);
        if (build.error || build.status !== 0) {
          record(
            step,
            false,
            build.error ? build.error.message : `server build exit code ${build.status}: ${(build.stderr || "").trim().slice(0, 200)}`,
          );
        } else {
          serverProc = spawn("node", ["--env-file-if-exists=.env", "dist/index.js"], {
            cwd: serverDir,
            env: { ...process.env, PORT: String(SERVER_PORT) },
            detached: true,
            stdio: "ignore",
          });

          let serverUp = false;
          {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && serverProc.exitCode === null) {
              try {
                const res = await fetch(SERVER_HEALTH_URL);
                serverUp = res.status === 200;
                break;
              } catch {
                await sleep(250);
              }
            }
          }

          if (!serverUp) {
            record(step, false, serverProc.exitCode !== null ? `server exited early with code ${serverProc.exitCode}` : `no healthy response on ${SERVER_HEALTH_URL} within 10s`);
          } else {
            clientProc = spawn("npm", ["start", "-w", "client"], {
              cwd: repoRoot,
              detached: true,
              stdio: "ignore",
            });

            let clientUp = false;
            {
              // Cold `ng serve` compiles the whole app before it listens — slow.
              const deadline = Date.now() + 120_000;
              while (Date.now() < deadline && clientProc.exitCode === null) {
                try {
                  const res = await fetch(CLIENT_URL);
                  clientUp = res.status === 200;
                  break;
                } catch {
                  await sleep(1000);
                }
              }
            }

            if (!clientUp) {
              record(step, false, clientProc.exitCode !== null ? `ng serve exited early with code ${clientProc.exitCode}` : `no response on ${CLIENT_URL} within 120s`);
            } else {
              let pageOk = false;
              let pageDetail = "";
              try {
                const res = await fetch(`${CLIENT_URL}/time-entries`);
                const html = await res.text();
                pageOk = res.status === 200 && /<app-root[\s>]/.test(html);
                pageDetail = `/time-entries -> HTTP ${res.status}: ${html.slice(0, 120)}`;
              } catch (err) {
                pageDetail = `/time-entries -> ${err.message}`;
              }

              let apiOk = false;
              let apiDetail = "";
              if (pageOk) {
                try {
                  const res = await fetch(`${CLIENT_URL}/api/time-entries?limit=1`);
                  let body;
                  try {
                    body = await res.json();
                  } catch (err) {
                    apiDetail = `/api/time-entries?limit=1 -> non-JSON response (status ${res.status}): ${err.message}`;
                  }
                  if (body !== undefined) {
                    apiOk = res.status === 200 && Array.isArray(body) && body.length <= 1;
                    apiDetail = `/api/time-entries?limit=1 -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`;
                  }
                } catch (err) {
                  apiDetail = `/api/time-entries?limit=1 -> ${err.message}`;
                }
              } else {
                apiDetail = "skipped — /time-entries did not come up";
              }

              if (pageOk && apiOk) {
                record(step, true);
              } else {
                record(step, false, [!pageOk && pageDetail, !apiOk && apiDetail].filter(Boolean).join(" | "));
              }
            }
          }
        }
      }
    }
  }
} finally {
  await killGroup(clientProc, "ng serve");
  await killGroup(serverProc, "server");

  if (!SKIP_SERVE) {
    const stillClient = await isPortOpen(CLIENT_PORT);
    const stillServer = await isPortOpen(SERVER_PORT);
    if (stillClient) console.log(`WARN: port ${CLIENT_PORT} still open after cleanup`);
    if (stillServer) console.log(`WARN: port ${SERVER_PORT} still open after cleanup`);
  }
}

const expectedTotal = SKIP_SERVE ? 3 : 4;
const passed = results.filter(Boolean).length;
console.log(`MT-10 QA: ${passed}/${expectedTotal} passed`);
process.exit(passed === expectedTotal ? 0 : 1);
