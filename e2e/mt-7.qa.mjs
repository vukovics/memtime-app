import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(repoRoot, "server");
const PORT = 3996;
const BASE_URL = `http://localhost:${PORT}`;
const HEALTH_URL = `${BASE_URL}/health`;
const SKIP_LIVE = process.env.MT7_SKIP_LIVE === "1";

const results = [];

function record(step, ok, reason) {
  results.push(ok);
  console.log(ok ? `PASS: ${step}` : `FAIL: ${step} — ${reason}`);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
}

/**
 * Rejects with a dedicated error on rate limiting. The proxy maps an
 * upstream 429 to a local 503 (see server/src/app.ts STATUS_BY_KIND /
 * UpstreamErrorKind "RateLimited") and sets Retry-After, so 503 from this
 * server — not a raw 429 — is the observable signal here.
 */
async function request(method, path, body) {
  const started = Date.now();
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await fetch(`${BASE_URL}${path}`, init);
  const elapsedMs = Date.now() - started;
  if (res.status === 429 || res.status === 503) {
    throw new Error("rate limited — wait 60s and rerun");
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`non-JSON response (status ${res.status}): ${err.message}`);
  }
  return { status: res.status, body: json, elapsedMs };
}

const getJson = (path) => request("GET", path);

// Today's 09:00Z..10:00Z window, in the ISO form app.ts's ISO_DATETIME regex
// accepts (date, "T", time, seconds, "Z").
const todayIso = new Date().toISOString().slice(0, 10);
const START = `${todayIso}T09:00:00Z`;
const END = `${todayIso}T10:00:00Z`;

let server = null;
let createdId = null;
let deleted = false;

async function runLocalValidationSteps() {
  // Step 2a: end < start -> 400 mentioning start/end, no upstream, fast.
  {
    const step = 'POST with end < start -> 400 mentions "start"/"end", fast (<50ms, no upstream)';
    try {
      const { status, body, elapsedMs } = await request("POST", "/api/time-entries", {
        taskId: 1,
        comment: "MT-7 QA entry",
        start: END,
        end: START,
      });
      if (status !== 400) {
        record(step, false, `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
      } else if (typeof body.error !== "string" || !/start/i.test(body.error) || !/end/i.test(body.error)) {
        record(step, false, `body.error does not mention start/end: ${JSON.stringify(body)}`);
      } else if (elapsedMs >= 50) {
        record(step, false, `elapsed ${elapsedMs}ms, expected <50ms (suggests an upstream call was made)`);
      } else {
        record(step, true);
      }
    } catch (err) {
      record(step, false, err.message);
    }
  }

  // Step 2b: missing comment -> 400 mentions comment, no upstream, fast.
  {
    const step = 'POST missing comment -> 400 mentions "comment", fast (<50ms, no upstream)';
    try {
      const { status, body, elapsedMs } = await request("POST", "/api/time-entries", {
        taskId: 1,
        start: START,
        end: END,
      });
      if (status !== 400) {
        record(step, false, `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
      } else if (typeof body.error !== "string" || !/comment/i.test(body.error)) {
        record(step, false, `body.error does not mention comment: ${JSON.stringify(body)}`);
      } else if (elapsedMs >= 50) {
        record(step, false, `elapsed ${elapsedMs}ms, expected <50ms (suggests an upstream call was made)`);
      } else {
        record(step, true);
      }
    } catch (err) {
      record(step, false, err.message);
    }
  }

  // Step 2c: malformed JSON -> local 400 "Invalid JSON body", no upstream, fast.
  {
    const step = 'POST malformed JSON "{nope" -> 400 "Invalid JSON body", fast (<50ms, no upstream)';
    try {
      const { status, body, elapsedMs } = await request("POST", "/api/time-entries", "{nope");
      if (status !== 400) {
        record(step, false, `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
      } else if (body.error !== "Invalid JSON body") {
        record(step, false, `body.error is "${body.error}", expected "Invalid JSON body"`);
      } else if (elapsedMs >= 50) {
        record(step, false, `elapsed ${elapsedMs}ms, expected <50ms (suggests an upstream call was made)`);
      } else {
        record(step, true);
      }
    } catch (err) {
      record(step, false, err.message);
    }
  }
}

try {
  // Step 0: build + start server, poll /health. Still needed under
  // MT7_SKIP_LIVE — the local-validation trio exercises real HTTP request
  // handling (fast local 400s), it just never calls upstream or discovers
  // a taskId, which is what SKIP_LIVE scopes out.
  {
    const step = "build + server starts, /health responds ok";
    const build = run("npm", ["run", "build", "-w", "server"]);
    const buildOk = !build.error && build.status === 0;
    if (!buildOk) {
      const reason = build.error
        ? build.error.message
        : `build exit code ${build.status}: ${(build.stderr || "").trim().slice(0, 200)}`;
      record(step, false, reason);
    } else {
      server = spawn("node", ["--env-file-if-exists=.env", "dist/index.js"], {
        cwd: serverDir,
        env: { ...process.env, PORT: String(PORT) },
        stdio: "ignore",
      });
      let listening = false;
      let healthBody = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && server.exitCode === null) {
        try {
          const res = await fetch(HEALTH_URL);
          healthBody = await res.json();
          listening = res.status === 200;
          break;
        } catch {
          await sleep(250);
        }
      }
      if (listening && healthBody?.status === "ok") record(step, true);
      else if (server.exitCode !== null) record(step, false, `server exited early with code ${server.exitCode}`);
      else record(step, false, `no healthy response on ${HEALTH_URL} within 10s`);
    }
  }

  if (SKIP_LIVE) {
    // Only the local-validation trio runs; no server, no upstream calls.
    console.log("live steps skipped (MT7_SKIP_LIVE=1)");
    await runLocalValidationSteps();
  } else {
    // Step 1: discover a real taskId by walking clients -> projects -> tasks.
    // May be served from cache (0 live calls) or cost live calls; the fixed
    // CRUD steps below (3,4,5,6,7,8) always cost 6, so discovery is capped
    // at 3 live calls here to hold the overall run to the 9-call budget.
    let taskId = null;
    const DISCOVERY_LIVE_CALL_BUDGET = 3;
    let discoveryLiveCalls = 0;
    async function getJsonBudgeted(path) {
      discoveryLiveCalls += 1;
      if (discoveryLiveCalls > DISCOVERY_LIVE_CALL_BUDGET) {
        throw new Error("discovery live-call budget exhausted");
      }
      return getJson(path);
    }
    {
      const step = "discover a real taskId via /api/clients -> /projects -> /tasks";
      try {
        const { status: clientsStatus, body: clients } = await getJsonBudgeted("/api/clients?limit=10");
        if (clientsStatus !== 200 || !Array.isArray(clients) || clients.length === 0) {
          record(step, false, `no clients available: HTTP ${clientsStatus} ${JSON.stringify(clients).slice(0, 200)}`);
        } else {
          outer: for (const c of clients) {
            const { status: projStatus, body: projects } = await getJsonBudgeted(`/api/clients/${c.id}/projects`);
            if (projStatus !== 200 || !Array.isArray(projects)) continue;
            for (const p of projects) {
              const { status: taskStatus, body: tasks } = await getJsonBudgeted(`/api/projects/${p.id}/tasks`);
              if (taskStatus === 200 && Array.isArray(tasks) && tasks.length > 0) {
                taskId = tasks[0].id;
                break outer;
              }
            }
          }
          if (typeof taskId === "number") record(step, true);
          else record(step, false, "no task found within the discovery live-call budget");
        }
      } catch (err) {
        record(step, false, err.message);
      }
    }

    // Step 2: local validation trio (0 live, must run before create).
    await runLocalValidationSteps();

    // Step 3: POST valid entry -> 201 with numeric id + echoed fields. [1 live]
    {
      const step = "POST valid entry -> 201 with numeric id + echoed fields";
      if (taskId === null) {
        record(step, false, "skipped — no taskId discovered in step 1");
      } else {
        try {
          const { status, body } = await request("POST", "/api/time-entries", {
            taskId,
            comment: "MT-7 QA entry",
            start: START,
            end: END,
          });
          // Upstream normalizes start/end to full millisecond ISO form (e.g.
          // "09:00:00Z" -> "09:00:00.000Z"), so compare by instant, not string.
          if (status !== 201) {
            record(step, false, `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
          } else if (typeof body.id !== "number") {
            record(step, false, `body.id is not numeric: ${JSON.stringify(body).slice(0, 200)}`);
          } else if (
            body.taskId !== taskId ||
            body.comment !== "MT-7 QA entry" ||
            Date.parse(body.start) !== Date.parse(START) ||
            Date.parse(body.end) !== Date.parse(END)
          ) {
            record(step, false, `echoed fields mismatch: ${JSON.stringify(body).slice(0, 200)}`);
          } else {
            createdId = body.id;
            record(step, true);
          }
        } catch (err) {
          record(step, false, err.message);
        }
      }
    }

    // Step 4: GET the created entry -> 200, comment matches. [1 live]
    {
      const step = "GET /api/time-entries/<id> -> 200, comment matches";
      if (createdId === null) {
        record(step, false, "skipped — step 3 did not create an entry");
      } else {
        try {
          const { status, body } = await getJson(`/api/time-entries/${createdId}`);
          if (status !== 200) {
            record(step, false, `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
          } else if (body.comment !== "MT-7 QA entry") {
            record(step, false, `comment is "${body.comment}", expected "MT-7 QA entry"`);
          } else {
            record(step, true);
          }
        } catch (err) {
          record(step, false, err.message);
        }
      }
    }

    // Step 5: PUT same body, updated comment -> 200, comment updated. [1 live]
    {
      const step = "PUT /api/time-entries/<id> updated comment -> 200, comment updated";
      if (createdId === null) {
        record(step, false, "skipped — step 3 did not create an entry");
      } else {
        try {
          const { status, body } = await request("PUT", `/api/time-entries/${createdId}`, {
            taskId,
            comment: "MT-7 QA entry (updated)",
            start: START,
            end: END,
          });
          if (status !== 200) {
            record(step, false, `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
          } else if (body.comment !== "MT-7 QA entry (updated)") {
            record(step, false, `comment is "${body.comment}", expected "MT-7 QA entry (updated)"`);
          } else {
            record(step, true);
          }
        } catch (err) {
          record(step, false, err.message);
        }
      }
    }

    // Step 6: DELETE -> 200 {message}. [1 live]
    {
      const step = "DELETE /api/time-entries/<id> -> 200 {message}";
      if (createdId === null) {
        record(step, false, "skipped — step 3 did not create an entry");
      } else {
        try {
          const { status, body } = await request("DELETE", `/api/time-entries/${createdId}`);
          if (status !== 200) {
            record(step, false, `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
          } else if (typeof body.message !== "string" || body.message.length === 0) {
            record(step, false, `body.message is not a non-empty string: ${JSON.stringify(body)}`);
          } else {
            deleted = true;
            record(step, true);
          }
        } catch (err) {
          record(step, false, err.message);
        }
      }
    }

    // Step 7: GET the deleted entry again -> 404 {error}. [1 live]
    {
      const step = "GET /api/time-entries/<id> again -> 404 {error}";
      if (createdId === null) {
        record(step, false, "skipped — step 3 did not create an entry");
      } else if (!deleted) {
        record(step, false, "skipped — step 6 did not confirm delete");
      } else {
        try {
          const { status, body } = await getJson(`/api/time-entries/${createdId}`);
          if (status !== 404) {
            record(step, false, `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
          } else if (typeof body.error !== "string" || body.error.length === 0) {
            record(step, false, `body.error is not a non-empty string: ${JSON.stringify(body)}`);
          } else {
            record(step, true);
          }
        } catch (err) {
          record(step, false, err.message);
        }
      }
    }

    // Step 8: PUT an unknown id with a valid body -> 404. [1 live]
    {
      const step = "PUT /api/time-entries/999999 valid body -> 404";
      const body999 =
        taskId === null
          ? { taskId: 1, comment: "MT-7 QA entry", start: START, end: END }
          : { taskId, comment: "MT-7 QA entry", start: START, end: END };
      try {
        const { status, body } = await request("PUT", "/api/time-entries/999999", body999);
        if (status !== 404) {
          record(step, false, `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
        } else {
          record(step, true);
        }
      } catch (err) {
        record(step, false, err.message);
      }
    }
  }
} finally {
  // Cleanup guarantee: if a later step failed before confirming delete,
  // still attempt to remove the created entry; ignore the outcome. Skipped
  // when step 6 already confirmed the delete, so the success path never
  // spends an extra live call here.
  if (createdId !== null && !deleted && !SKIP_LIVE) {
    try {
      await request("DELETE", `/api/time-entries/${createdId}`);
    } catch {
      // best-effort cleanup
    }
  }
  if (server && server.exitCode === null) server.kill("SIGTERM");
}

const passed = results.filter(Boolean).length;
console.log(`MT-7 QA: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
