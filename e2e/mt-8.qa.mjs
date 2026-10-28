import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDir = join(repoRoot, "client");
const serverDir = join(repoRoot, "server");
const SERVER_PORT = 3000; // ng serve's proxy.conf.json targets localhost:3000 — not configurable per-run.
const CLIENT_PORT = 4200;
const CLIENT_URL = `http://localhost:${CLIENT_PORT}`;
const SERVER_HEALTH_URL = `http://localhost:${SERVER_PORT}/health`;
const SKIP_SERVE = process.env.MT8_SKIP_SERVE === "1";

const results = [];

function record(step, ok, reason) {
  results.push(ok);
  console.log(ok ? `PASS: ${step}` : `FAIL: ${step} — ${reason}`);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
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

/** Recursively collects all file paths under dir (skips nothing — dist/src are small, generated trees). */
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
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
  // Step 1: unit tests (16: ApiService URLs/params, interceptor, shell).
  {
    const step = "npm test -w client -- --watch=false passes (16 unit tests)";
    const test = run("npm", ["test", "-w", "client", "--", "--watch=false"]);
    if (test.error) {
      record(step, false, test.error.message);
    } else if (test.status !== 0) {
      record(step, false, `exit code ${test.status}: ${(test.stderr || test.stdout || "").trim().slice(0, 300)}`);
    } else {
      record(step, true);
    }
  }

  // Step 2: production build.
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

  // Step 3: no API key / auth leakage into client code or build output.
  {
    const step = "no API key or Bearer auth leaked into client/src or client/dist";
    try {
      const envPath = join(serverDir, ".env");
      if (!existsSync(envPath)) {
        record(step, false, `server/.env missing at ${envPath}`);
      } else {
        const match = readFileSync(envPath, "utf8").match(/^API_KEY=(.+)$/m);
        const apiKey = match?.[1]?.trim();
        if (!apiKey) {
          record(step, false, "could not read API_KEY from server/.env");
        } else {
          const files = [...walk(join(clientDir, "src")), ...walk(join(clientDir, "dist"))];
          const keyHits = [];
          let bearerHit = null;
          for (const f of files) {
            let text;
            try {
              text = readFileSync(f, "utf8");
            } catch {
              continue; // binary/unreadable (e.g. favicon.ico) — can't contain the key as text
            }
            if (text.includes(apiKey)) keyHits.push(f);
            if (bearerHit === null && f.startsWith(join(clientDir, "src")) && text.includes("Bearer")) {
              bearerHit = f;
            }
          }
          if (keyHits.length > 0) {
            record(step, false, `API key found in: ${keyHits.join(", ")}`);
          } else if (bearerHit !== null) {
            record(step, false, `"Bearer" found in client/src: ${bearerHit}`);
          } else {
            record(step, true);
          }
        }
      }
    } catch (err) {
      record(step, false, err.message);
    }
  }

  if (SKIP_SERVE) {
    console.log("serve steps skipped (MT8_SKIP_SERVE=1)");
  } else {
    // Step 4: serve + routes — start server on 3000 (proxy target is hardcoded), start ng serve on 4200.
    {
      const step = "server + ng serve up; / , /browse, /time-entries all return 200 HTML with app root";
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
              const checks = [];
              for (const path of ["/", "/browse", "/time-entries"]) {
                try {
                  const res = await fetch(`${CLIENT_URL}${path}`);
                  const html = await res.text();
                  const ok = res.status === 200 && /<app-root[\s>]/.test(html);
                  checks.push({ path, ok, status: res.status, snippet: html.slice(0, 120) });
                } catch (err) {
                  checks.push({ path, ok: false, status: null, snippet: err.message });
                }
              }
              const failed = checks.filter((c) => !c.ok);
              if (failed.length > 0) {
                record(step, false, failed.map((f) => `${f.path} -> HTTP ${f.status}: ${f.snippet}`).join(" | "));
              } else {
                record(step, true);
              }
            }
          }
        }
      }
    }

    // Step 5: proxy wiring — through ng serve's dev proxy to the express server. [<=1 live]
    {
      const step = "GET /api/clients?limit=1 through ng proxy -> 200 JSON array";
      if (results[results.length - 1] !== true) {
        record(step, false, "skipped — serve step did not come up");
      } else {
        try {
          const res = await fetch(`${CLIENT_URL}/api/clients?limit=1`);
          let body;
          try {
            body = await res.json();
          } catch (err) {
            record(step, false, `non-JSON response (status ${res.status}): ${err.message}`);
            body = undefined;
          }
          if (body !== undefined) {
            if (res.status !== 200) {
              record(step, false, `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
            } else if (!Array.isArray(body) || body.length > 1) {
              record(step, false, `body is not an array of <=1 items: ${JSON.stringify(body).slice(0, 200)}`);
            } else {
              record(step, true);
            }
          }
        } catch (err) {
          record(step, false, err.message);
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

const expectedTotal = SKIP_SERVE ? 3 : 5;
const passed = results.filter(Boolean).length;
console.log(`MT-8 QA: ${passed}/${expectedTotal} passed`);
process.exit(passed === expectedTotal ? 0 : 1);
