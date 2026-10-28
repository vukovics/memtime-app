import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const results = [];

function record(step, ok, reason) {
  results.push(ok);
  console.log(ok ? `PASS: ${step}` : `FAIL: ${step} — ${reason}`);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8" });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Step 1: npm install succeeds
{
  const step = "npm install completes without errors";
  const res = run("npm", ["install"]);
  if (res.error) record(step, false, res.error.message);
  else if (res.status !== 0) record(step, false, `exit code ${res.status}: ${res.stderr.trim().slice(0, 200)}`);
  else record(step, true);
}

// Step 2: workspaces and private sub-packages
{
  const step = 'workspaces are exactly ["server","client"] and both are private';
  try {
    const root = readJson(join(repoRoot, "package.json"));
    const ws = root.workspaces;
    if (!Array.isArray(ws) || ws.length !== 2 || !ws.includes("server") || !ws.includes("client")) {
      record(step, false, `workspaces is ${JSON.stringify(ws)}`);
    } else {
      const notPrivate = ["server", "client"].filter(
        (dir) => readJson(join(repoRoot, dir, "package.json")).private !== true
      );
      if (notPrivate.length > 0) record(step, false, `not "private": true in ${notPrivate.join(", ")}/package.json`);
      else record(step, true);
    }
  } catch (err) {
    record(step, false, err.message);
  }
}

// Step 3: .gitignore rules
{
  const step = ".gitignore ignores node_modules, dist, .env, .DS_Store, data.sqlite but not .env.example";
  // Directory patterns are probed via a child path so the check does not
  // depend on the directory existing on disk.
  const mustIgnore = ["node_modules/probe", "dist/probe", ".env", ".DS_Store", "data.sqlite"];
  const notIgnored = mustIgnore.filter((p) => run("git", ["check-ignore", "-q", p]).status !== 0);
  const envExampleIgnored = run("git", ["check-ignore", "-q", ".env.example"]).status === 0;
  if (notIgnored.length > 0) record(step, false, `not ignored: ${notIgnored.join(", ")}`);
  else if (envExampleIgnored) record(step, false, ".env.example is ignored but must not be");
  else record(step, true);
}

// Step 4: .editorconfig
{
  const step = ".editorconfig exists with root = true";
  const path = join(repoRoot, ".editorconfig");
  if (!existsSync(path)) record(step, false, "file missing");
  else if (!/^\s*root\s*=\s*true\s*$/m.test(readFileSync(path, "utf8"))) record(step, false, "no 'root = true' line");
  else record(step, true);
}

// Step 5: README mentions project name
{
  const step = "README.md mentions Memtime";
  const path = join(repoRoot, "README.md");
  if (!existsSync(path)) record(step, false, "file missing");
  else if (!/memtime/i.test(readFileSync(path, "utf8"))) record(step, false, "no mention of Memtime/memtime");
  else record(step, true);
}

// Step 6: no planning docs in git (docs/GHERKIN.md and docs/QA_PROCEDURE.md are expected and not flagged)
{
  const step = "git tracks no private planning docs (TICKETS/AGENT_PIPELINE)";
  const pattern = /TICKETS|AGENT_PIPELINE/;
  const lsFiles = run("git", ["ls-files"]);
  const status = run("git", ["status", "--porcelain"]);
  if (lsFiles.status !== 0 || status.status !== 0) {
    record(step, false, "git command failed");
  } else {
    const offenders = (lsFiles.stdout + "\n" + status.stdout)
      .split("\n")
      .filter((line) => pattern.test(line));
    if (offenders.length > 0) record(step, false, `found: ${offenders.join(", ")}`);
    else record(step, true);
  }
}

const passed = results.filter(Boolean).length;
console.log(`MT-1 QA: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
