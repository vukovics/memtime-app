import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(repoRoot, "server");
const PORT = 3998;
const HEALTH_URL = `http://localhost:${PORT}/health`;

const results = [];

function record(step, ok, reason) {
  results.push(ok);
  console.log(ok ? `PASS: ${step}` : `FAIL: ${step} — ${reason}`);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
}

// Wait for a spawned child to exit; resolves to { code, timedOut }.
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, timedOut: true }), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });
}

let server = null;

try {
  // Build once; steps 1-3 run the compiled output.
  const build = run("npm", ["run", "build", "-w", "server"]);
  const buildOk = !build.error && build.status === 0;
  const buildReason = build.error
    ? build.error.message
    : `build exit code ${build.status}: ${(build.stderr || "").trim().slice(0, 200)}`;

  // Step 1: server starts and listens on the configured port
  {
    const step = `server starts and listens on PORT=${PORT}`;
    if (!buildOk) {
      record(step, false, buildReason);
    } else {
      server = spawn("node", ["--env-file-if-exists=nonexistent.env", "dist/index.js"], {
        cwd: serverDir,
        env: { ...process.env, API_KEY: "qa-dummy-key", PORT: String(PORT) },
        stdio: "ignore",
      });
      let listening = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && server.exitCode === null) {
        try {
          await fetch(HEALTH_URL);
          listening = true;
          break;
        } catch {
          await sleep(250);
        }
      }
      if (listening) record(step, true);
      else if (server.exitCode !== null) record(step, false, `server exited early with code ${server.exitCode}`);
      else record(step, false, `no response on ${HEALTH_URL} within 10s`);
    }
  }

  // Step 2: GET /health returns 200 with JSON status "ok"
  {
    const step = 'GET /health returns 200 and JSON body with status "ok"';
    try {
      const res = await fetch(HEALTH_URL);
      if (res.status !== 200) {
        record(step, false, `HTTP ${res.status}`);
      } else {
        const body = await res.json();
        if (body.status !== "ok") record(step, false, `body is ${JSON.stringify(body)}`);
        else record(step, true);
      }
    } catch (err) {
      record(step, false, err.message);
    }
  }

  // Step 3: missing API_KEY exits 1 fast with an error naming API_KEY
  {
    const step = "missing API_KEY exits with code 1 and an error naming API_KEY";
    if (!buildOk) {
      record(step, false, buildReason);
    } else {
      // Point the env-file flag at a nonexistent file so server/.env
      // placeholders cannot mask the missing variable.
      const env = { ...process.env };
      delete env.API_KEY;
      const child = spawn("node", ["--env-file-if-exists=nonexistent.env", "dist/index.js"], {
        cwd: serverDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const { code, timedOut } = await waitForExit(child, 5_000);
      if (timedOut) {
        child.kill("SIGKILL");
        record(step, false, "did not exit within 5s");
      } else if (code !== 1) {
        record(step, false, `exit code ${code}, expected 1`);
      } else if (!output.includes("API_KEY")) {
        record(step, false, `error output does not mention API_KEY: ${output.trim().slice(0, 200)}`);
      } else {
        record(step, true);
      }
    }
  }

  // Step 4: secrets hygiene — .env ignored and untracked, .env.example tracked with placeholder only
  {
    const step = "server/.env is git-ignored and untracked; .env.example goes to git with placeholder API_KEY";
    try {
      const ignored = run("git", ["check-ignore", "-q", "server/.env"]).status === 0;
      const exampleIgnored = run("git", ["check-ignore", "-q", "server/.env.example"]).status === 0;
      const tracked = run("git", ["ls-files"]).stdout.split("\n");
      const envTracked = tracked.includes("server/.env");
      const example = readFileSync(join(serverDir, ".env.example"), "utf8");
      const keyLine = example.split("\n").find((l) => /^API_KEY=/.test(l)) ?? "";
      const placeholderValue = keyLine.slice(keyLine.indexOf("=") + 1).trim();
      const looksLikePlaceholder = /your-api-key/i.test(keyLine);
      const looksLikeRealKey = /^[A-Za-z0-9_-]{32,}$/.test(placeholderValue);
      if (!ignored) record(step, false, "git check-ignore says server/.env is not ignored");
      else if (envTracked) record(step, false, "server/.env is tracked by git");
      else if (exampleIgnored) record(step, false, "server/.env.example is git-ignored, so it cannot be committed");
      else if (!looksLikePlaceholder) record(step, false, `API_KEY in .env.example is not a placeholder: "${keyLine}"`);
      else if (looksLikeRealKey) record(step, false, `API_KEY in .env.example looks like a real key: "${keyLine}"`);
      else record(step, true);
    } catch (err) {
      record(step, false, err.message);
    }
  }
} finally {
  if (server && server.exitCode === null) server.kill("SIGTERM");
}

const passed = results.filter(Boolean).length;
console.log(`MT-2 QA: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
