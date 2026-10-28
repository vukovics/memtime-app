import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverDir = join(repoRoot, "server");
const serverSrc = join(serverDir, "src");

const results = [];

function record(step, ok, reason) {
  results.push(ok);
  console.log(ok ? `PASS: ${step}` : `FAIL: ${step} — ${reason}`);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
}

// Minimal .env line parser: KEY=VALUE, skips comments and blank lines.
function parseEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function listFilesRecursive(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFilesRecursive(full) : [full];
  });
}

// True if the error is the upstream 429 — caller reports the rerun hint.
function isRateLimited(err) {
  return err?.name === "UpstreamApiError" && (err.kind === "RateLimited" || err.status === 429);
}
const RATE_LIMIT_HINT = "rate limited — wait 60s and rerun";

const dotenv = parseEnvFile(join(serverDir, ".env"));
const apiKey = dotenv.API_KEY;
const baseUrl = dotenv.UPSTREAM_BASE_URL ?? "https://interview-api.memtime-demo.deno.net/api/v1";

// Build once; live steps import the compiled client.
const build = run("npm", ["run", "build", "-w", "server"]);
const buildOk = !build.error && build.status === 0;
const buildReason = build.error
  ? build.error.message
  : `build exit code ${build.status}: ${(build.stderr || "").trim().slice(0, 200)}`;

let client = null;
let clientModule = null;
if (!apiKey) {
  // Live steps will report this.
} else if (buildOk) {
  try {
    clientModule = await import(
      pathToFileURL(join(serverDir, "dist", "upstream", "client.js")).href
    );
    client = clientModule.createUpstreamClient({ baseUrl, apiKey });
  } catch (err) {
    clientModule = { importError: err.message };
  }
}

// Step 1: live smoke — listClients({limit: 1}) returns real client data [1 live request]
{
  const step = "live listClients({limit: 1}) returns an array of clients with numeric id and name";
  if (!apiKey) {
    record(step, false, "API_KEY missing from server/.env");
  } else if (!buildOk) {
    record(step, false, buildReason);
  } else if (!client) {
    record(step, false, `could not import compiled client: ${clientModule?.importError}`);
  } else {
    try {
      const clients = await client.listClients({ limit: 1 });
      if (!Array.isArray(clients)) {
        record(step, false, `expected an array, got ${typeof clients}`);
      } else if (clients.length === 0) {
        record(step, false, "upstream returned an empty array; expected at least one client");
      } else if (
        !clients.every((c) => typeof c?.id === "number" && typeof c?.name === "string" && c.name.length > 0)
      ) {
        record(step, false, `entries missing numeric id/name: ${JSON.stringify(clients).slice(0, 200)}`);
      } else {
        record(step, true);
      }
    } catch (err) {
      record(step, false, isRateLimited(err) ? RATE_LIMIT_HINT : err.message);
    }
  }
}

// Step 2: static — real key value appears nowhere under server/src/
{
  const step = "real API key from server/.env appears nowhere under server/src/";
  try {
    if (!apiKey) {
      record(step, false, "API_KEY missing from server/.env, cannot scan for leaks");
    } else {
      const leaks = listFilesRecursive(serverSrc).filter((f) => readFileSync(f, "utf8").includes(apiKey));
      if (leaks.length > 0) record(step, false, `real API key found in: ${leaks.join(", ")}`);
      else record(step, true);
    }
  } catch (err) {
    record(step, false, err.message);
  }
}

// Step 3: unit suite green — proves header injection, pagination, and error mapping
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

// Step 4: typed 404 — getClient on an absurd id throws UpstreamApiError NotFound [1 live request]
{
  const step = 'getClient(999999) throws UpstreamApiError with kind "NotFound" and an upstream message';
  if (!apiKey) {
    record(step, false, "API_KEY missing from server/.env");
  } else if (!buildOk) {
    record(step, false, buildReason);
  } else if (!client) {
    record(step, false, `could not import compiled client: ${clientModule?.importError}`);
  } else {
    try {
      const unexpected = await client.getClient(999999);
      record(step, false, `expected a throw, got: ${JSON.stringify(unexpected).slice(0, 200)}`);
    } catch (err) {
      if (isRateLimited(err)) {
        record(step, false, RATE_LIMIT_HINT);
      } else if (!(err instanceof clientModule.UpstreamApiError)) {
        record(step, false, `threw ${err?.name ?? typeof err}, not UpstreamApiError: ${err?.message}`);
      } else if (err.kind !== "NotFound") {
        record(step, false, `kind is "${err.kind}", expected "NotFound"`);
      } else if (typeof err.upstreamMessage !== "string" || err.upstreamMessage.length === 0) {
        record(step, false, "upstreamMessage is empty");
      } else {
        record(step, true);
      }
    }
  }
}

const passed = results.filter(Boolean).length;
console.log(`MT-3 QA: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
