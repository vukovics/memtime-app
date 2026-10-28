import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const results = [];

function record(step, ok, reason) {
  results.push(ok);
  console.log(ok ? `PASS: ${step}` : `FAIL: ${step} — ${reason}`);
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd: cwd ?? repoRoot, encoding: "utf8" });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const readmePath = join(repoRoot, "README.md");
const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";

// Step 1: README completeness — required sections, rate limit, key secrecy, a
// fenced ```text diagram, and a markdown table.
{
  const step = "README.md has all required sections and explains rate limit/key secrecy";
  const missing = [];
  for (const needle of ["setup", "architecture", "api", "testing", "improve"]) {
    if (!readme.toLowerCase().includes(needle)) missing.push(`heading-ish text "${needle}"`);
  }
  if (!/15 req(uests)?/i.test(readme)) missing.push('"15 req" / "15 requests" (rate limit)');
  if (!/api key/i.test(readme)) missing.push('"API key" (secrecy explained)');
  if (!/```text[\s\S]*?```/.test(readme)) missing.push("fenced ```text diagram block");
  if (!/^\|/m.test(readme)) missing.push("markdown table (line starting with |)");
  if (!readme) missing.push("README.md missing");
  if (missing.length > 0) record(step, false, `missing: ${missing.join(", ")}`);
  else record(step, true);
}

// Step 2: setup accuracy — every `npm` command quoted in the README references
// a script that actually exists in the relevant package.json.
{
  const step = "every npm command quoted in README references a real script";
  const pkgCache = {};
  function scripts(dir) {
    if (!(dir in pkgCache)) {
      const path = join(repoRoot, dir, "package.json");
      pkgCache[dir] = existsSync(path) ? readJson(path).scripts ?? {} : null;
    }
    return pkgCache[dir];
  }

  const lines = readme.split("\n").filter((line) => /npm (run |start|test|install)/.test(line));
  const unknown = [];
  for (const line of lines) {
    const workspace = /-w\s+(server|client)/.exec(line)?.[1] ?? null;
    const dir = workspace ?? "."; // bare "npm install"/root commands
    for (const match of line.matchAll(/npm (run |start|test|install)([a-zA-Z0-9_:-]*)/g)) {
      const [, kind, rest] = match;
      const name = rest.trim();
      if (kind === "install") continue; // always valid
      const scriptName = kind === "run " ? name : kind.trim(); // "start"/"test" ARE the script name
      if (!scriptName) continue;
      const pkgScripts = scripts(dir);
      if (pkgScripts === null) {
        unknown.push(`${line.trim()} (no package.json for -w ${dir})`);
      } else if (!(scriptName in pkgScripts)) {
        unknown.push(`"${scriptName}" in ${dir}/package.json (from: ${line.trim()})`);
      }
    }
  }
  if (unknown.length > 0) record(step, false, unknown.join(" | "));
  else record(step, true);
}

// Step 3: secrets — the real API_KEY value from server/.env appears in no
// tracked file. `git grep` only searches tracked content, so an untracked/
// git-ignored server/.env cannot taint the result.
{
  const step = "server/.env API_KEY value appears in no tracked file (git grep)";
  const envPath = join(repoRoot, "server", ".env");
  if (!existsSync(envPath)) {
    record(step, false, "server/.env missing — cannot read API_KEY to check");
  } else {
    const match = /^API_KEY=(.+)$/m.exec(readFileSync(envPath, "utf8"));
    const key = match?.[1]?.trim();
    if (!key) {
      record(step, false, "no API_KEY= line found in server/.env");
    } else {
      const grep = run("git", ["grep", "-l", key]);
      // git grep exit codes: 0 = match found, 1 = no match, >1 = error.
      if (grep.status === 1) record(step, true);
      else if (grep.status === 0) record(step, false, `key value found in tracked file(s): ${grep.stdout.trim()}`);
      else record(step, false, `git grep failed: ${grep.stderr.trim()}`);
    }
  }
}

// Step 4: links — docs exist and client/README.md points back to the root README.
{
  const step = "docs/GHERKIN.md, docs/QA_PROCEDURE.md, client/README.md exist and cross-link";
  const gherkinPath = join(repoRoot, "docs", "GHERKIN.md");
  const qaProcPath = join(repoRoot, "docs", "QA_PROCEDURE.md");
  const clientReadmePath = join(repoRoot, "client", "README.md");
  const missing = [gherkinPath, qaProcPath, clientReadmePath]
    .filter((p) => !existsSync(p))
    .map((p) => p.slice(repoRoot.length + 1));
  if (missing.length > 0) {
    record(step, false, `missing: ${missing.join(", ")}`);
  } else if (!/readme/i.test(readFileSync(clientReadmePath, "utf8"))) {
    record(step, false, "client/README.md does not mention the root README");
  } else {
    record(step, true);
  }
}

// Step 5: whole-project gate — full server and client unit suites must pass.
// This is the LAST ticket, so this step also stands in for a whole-project gate.
{
  const step = "npm test -w server AND npm test -w client -- --watch=false both exit 0 (161 + 75 tests)";
  const server = run("npm", ["test", "-w", "server"]);
  const client = run("npm", ["test", "-w", "client", "--", "--watch=false"]);
  const failures = [];
  if (server.error) failures.push(`server: ${server.error.message}`);
  else if (server.status !== 0) failures.push(`server exit ${server.status}: ${(server.stderr || server.stdout || "").trim().slice(0, 300)}`);
  if (client.error) failures.push(`client: ${client.error.message}`);
  else if (client.status !== 0) failures.push(`client exit ${client.status}: ${(client.stderr || client.stdout || "").trim().slice(0, 300)}`);
  if (failures.length > 0) record(step, false, failures.join(" | "));
  else record(step, true);
}

const passed = results.filter(Boolean).length;
console.log(`MT-13 QA: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
