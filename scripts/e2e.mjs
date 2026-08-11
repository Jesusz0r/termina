import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const electronPath = require("electron");
const PORT = 9222;
const BASE_ROOT = "/tmp/pi-editor-test-project";
const BASE_EVENTS = "/tmp/pi-editor-events-test";
const BASE_WORLDS = "/tmp/pi-editor-worlds-test";
const PREFLIGHT_ROOT = "/tmp/pi-editor-preflight";
const USER_DATA_ROOT = "/tmp/pi-editor-e2e-user-data";

const BASIC_SUITES = [
  "explorer-test.mjs",
  "preview-test.mjs",
  "review-test.mjs",
  "timeline-test.mjs",
  "timeline-replay-test.mjs",
  "baseline-race-test.mjs",
  "edits-to-agent-test.mjs",
  "mine-ownership-test.mjs",
  "dispatch-test.mjs",
  "plan-board-test.mjs",
  "session-search-test.mjs",
  "tui-loop-test.mjs",
  "verify-test.mjs",
  "verify-cancel-test.mjs",
  "settings-test.mjs",
  "terminal-clipboard-test.mjs",
];
const WORLDLINE_SUITES = [
  "worldline-run-boundary-test.mjs",
  "worldline-fork-run-test.mjs",
  "worldline-compare-test.mjs",
  "worldline-promote-test.mjs",
  "worldline-recovery-test.mjs",
  "worldline-any-moment-test.mjs",
  "worldline-challenge-test.mjs",
  "worldline-isolation-test.mjs",
  "worldline-capture-test.mjs",
  "worldline-evidence-test.mjs",
  "worldline-trust-test.mjs",
  "worldline-cleanup-test.mjs",
];
const PREFLIGHT_CASES = ["plain", "nogit", "subdir", "conflict", "submodule", "autocrlf", "sparse"];
const ALL_SUITES = [...BASIC_SUITES, ...WORLDLINE_SUITES, "worldline-preflight-test.mjs"];

function normalizeSuite(value) {
  return value.endsWith(".mjs") ? value : `${value}.mjs`;
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, { maxBuffer: 8 * 1024 * 1024, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

async function git(root, args, input) {
  const result = await run("git", args, { cwd: root, input });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function put(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function reset(root) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
}

async function createGitRepo(root, files) {
  await reset(root);
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "e2e@pi-ditor.local"]);
  await git(root, ["config", "user.name", "pi-ditor e2e"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "fixture"]);
}

function baseFiles({ hello = false, other = false, tests = false, trust = false } = {}) {
  const files = {
    "greeting.ts": 'export const greeting = "hello";\n',
  };
  if (hello) files["hello.txt"] = "first\n";
  if (other) files["other.txt"] = "other\n";
  if (tests) {
    files["package.json"] = JSON.stringify({ name: "worldline-fixture", scripts: { test: "node test.js" } }, null, 2) + "\n";
    files["test.js"] = "const fs = require('fs');\nif (!fs.readFileSync('greeting.ts', 'utf8').includes('hi there')) { console.error('FAIL: greeting'); process.exit(1); }\n";
    files["other-test.js"] = "process.exit(1);\n";
  }
  if (trust) files[".pi/settings.json"] = '{"theme":"dark"}\n';
  return files;
}

async function prepareBasic(name) {
  if (name === "verify-test.mjs") {
    const root = "/tmp/pi-editor-verify-project";
    await reset(root);
    await put(root, "package.json", JSON.stringify({ name: "verify-fixture", scripts: { test: "node test.js" } }) + "\n");
    await put(root, "math.js", "exports.add = (a, b) => a + b + 1; // BUG\n");
    await put(root, "test.js", "const { add } = require('./math');\nif (add(2, 3) !== 5) { console.error('FAIL: add'); process.exit(1); }\n");
    return { root, events: "/tmp/pi-editor-verify-events", worlds: BASE_WORLDS };
  }
  if (name === "verify-cancel-test.mjs") {
    await reset(BASE_ROOT);
    await put(BASE_ROOT, "greeting.ts", 'export const greeting = "hello";\n');
    await put(BASE_ROOT, "package.json", JSON.stringify({ name: "cancel-fixture", scripts: { test: "node -e \"setTimeout(() => {}, 30000)\"" } }) + "\n");
    return { root: BASE_ROOT, events: BASE_EVENTS, worlds: BASE_WORLDS };
  }
  await reset(BASE_ROOT);
  await put(BASE_ROOT, "greeting.ts", 'export const greeting = "hello";\n');
  await put(BASE_ROOT, "hello.txt", "hello\n");
  await put(BASE_ROOT, "src/index.ts", "export const index = true;\n");
  return { root: BASE_ROOT, events: BASE_EVENTS, worlds: BASE_WORLDS };
}

function worldlinePaths(name) {
  const stem = name.replace("-test.mjs", "");
  const suffix = {
    "worldline-run-boundary": "",
    "worldline-fork-run": "",
    "worldline-compare": "2",
    "worldline-promote": "3",
    "worldline-recovery": "4",
    "worldline-any-moment": "5",
    "worldline-challenge": "6",
    "worldline-isolation": "7",
    "worldline-capture": "8",
    "worldline-evidence": "9",
    "worldline-trust": "10",
    "worldline-cleanup": "11",
  }[stem];
  const label = suffix === "" ? "" : suffix;
  return {
    root: `/tmp/pi-editor-wline${label}-project`,
    events: `/tmp/pi-editor-wline${label}-events`,
    worlds: `/tmp/pi-editor-wline${label}-worlds`,
  };
}

async function prepareWorldline(name) {
  const paths = worldlinePaths(name);
  const files = baseFiles({
    hello: ["worldline-any-moment-test.mjs", "worldline-isolation-test.mjs", "worldline-capture-test.mjs"].includes(name),
    other: name === "worldline-promote-test.mjs",
    tests: ["worldline-compare-test.mjs", "worldline-challenge-test.mjs", "worldline-evidence-test.mjs"].includes(name),
    trust: ["worldline-evidence-test.mjs", "worldline-trust-test.mjs"].includes(name),
  });
  await createGitRepo(paths.root, files);
  await reset(paths.events);
  await reset(paths.worlds);
  if (name === "worldline-recovery-test.mjs") await seedRecovery(paths.root, paths.worlds);
  if (name === "worldline-cleanup-test.mjs") await seedCleanup(paths.worlds);
  return paths;
}

async function seedRecovery(root, worlds) {
  const journalRoot = join(worlds, "promotion-journal");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const before = 'export const greeting = "hello";\n';
  const applied = 'export const greeting = "applied";\n';
  await put(root, "greeting.ts", before);
  await put(root, "other.txt", "done-state\n");
  await put(root, "conflict.txt", "external\n");
  const appliedDir = join(journalRoot, "recovery-1");
  await put(appliedDir, "before/greeting.ts", before);
  await put(appliedDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{ rel: "greeting.ts", beforeHash: hash(before), afterHash: hash(applied), beforeExists: true }],
  }));
  await put(join(journalRoot, "recovery-2"), "journal.json", JSON.stringify({ phase: "done", primaryRoot: root, paths: [] }));
  const conflictDir = join(journalRoot, "recovery-3");
  await put(conflictDir, "before/conflict.txt", "before\n");
  await put(conflictDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{ rel: "conflict.txt", beforeHash: hash("before\n"), afterHash: hash("applied\n"), beforeExists: true }],
  }));
}

async function seedCleanup(worlds) {
  const stale = join(worlds, "stale-cmp");
  await put(stale, ".pi-ditor-world", "owned\n");
  await put(stale, "manifest.json", JSON.stringify({ candidates: { A: { pid: 999999, lstart: "0" } } }));
  await put(worlds, "foreign-dir/keep.txt", "keep\n");
}

async function preparePreflight(testCase) {
  const root = join(PREFLIGHT_ROOT, testCase === "nogit" ? "nogit" : "repo");
  const files = baseFiles();
  if (testCase === "conflict") files["conflict-file.txt"] = "conflict\n";
  if (testCase === "submodule") files["submodule.txt"] = "submodule\n";
  await createGitRepo(root, files);
  if (testCase === "nogit") {
    await rm(join(root, ".git"), { recursive: true, force: true });
    return { root, events: join(PREFLIGHT_ROOT, "events-nogit"), worlds: join(PREFLIGHT_ROOT, "worlds-nogit") };
  }
  if (testCase === "subdir") {
    await put(root, "subdir/greeting.ts", 'export const greeting = "hello";\n');
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "subdir"]);
    return { root: join(root, "subdir"), events: join(PREFLIGHT_ROOT, "events-subdir"), worlds: join(PREFLIGHT_ROOT, "worlds-subdir") };
  }
  if (testCase === "autocrlf") await git(root, ["config", "core.autocrlf", "true"]);
  if (testCase === "sparse") {
    await git(root, ["sparse-checkout", "init", "--no-cone"]);
    await put(root, ".git/info/sparse-checkout", "greeting.ts\n");
    await git(root, ["read-tree", "-mu", "HEAD"]);
  }
  if (testCase === "submodule") {
    const source = join(PREFLIGHT_ROOT, "submodule-source");
    await createGitRepo(source, { "module.txt": "module\n" });
    const result = await run("git", ["-c", "protocol.file.allow=always", "submodule", "add", source, "vendor"], { cwd: root });
    if (result.code !== 0) throw new Error(`submodule setup failed: ${result.stderr}`);
    await git(root, ["commit", "-qm", "submodule"]);
  }
  return { root, events: join(PREFLIGHT_ROOT, `events-${testCase}`), worlds: join(PREFLIGHT_ROOT, `worlds-${testCase}`) };
}

async function prepare(name, testCase) {
  if (name === "worldline-preflight-test.mjs") return preparePreflight(testCase);
  if (WORLDLINE_SUITES.includes(name)) return prepareWorldline(name);
  return prepareBasic(name);
}

async function waitForRemoteDebugging() {
  for (let i = 0; i < 90; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`);
      if (response.ok) return;
    } catch {
      // The Electron process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Electron did not open the remote debugging port");
}

async function clearDebugPort() {
  const result = await run("lsof", ["-tiTCP:9222", "-sTCP:LISTEN"]);
  for (const value of result.stdout.split(/\s+/).filter(Boolean)) {
    const pid = Number(value);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The listener can exit before the cleanup signal.
      }
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function runSuite(name, testCase) {
  const fixture = await prepare(name, testCase);
  await rm(fixture.events, { recursive: true, force: true });
  await mkdir(fixture.events, { recursive: true });
  await rm(fixture.worlds, { recursive: true, force: true });
  await mkdir(fixture.worlds, { recursive: true });
  const userData = join(USER_DATA_ROOT, `${name.replace(/[^a-z0-9-]/gi, "-")}${testCase ? `-${testCase}` : ""}`);
  await rm(userData, { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
  await clearDebugPort();
  if (name === "worldline-recovery-test.mjs") await seedRecovery(fixture.root, fixture.worlds);
  if (name === "worldline-cleanup-test.mjs") await seedCleanup(fixture.worlds);

  const env = {
    ...process.env,
    PI_EDITOR_INITIAL_CWD: fixture.root,
    PI_EDITOR_EVENTS_DIR: fixture.events,
    PI_EDITOR_WORLDS_DIR: fixture.worlds,
    PI_EDITOR_USER_DATA_DIR: userData,
  };
  if (testCase) env.PREFLIGHT_CASE = testCase;
  const app = spawn(electronPath, [".", `--remote-debugging-port=${PORT}`], { env, detached: true, stdio: "inherit" });
  try {
    await waitForRemoteDebugging();
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const test = spawn(process.execPath, [join(process.cwd(), "scripts", name)], { env, stdio: "inherit" });
    return await new Promise((resolve) => {
      test.on("error", () => resolve(1));
      test.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    await stopProcess(app);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const requested = args.filter((arg) => !arg.startsWith("--"));
  const skipBuild = args.includes("--skip-build");
  if (!skipBuild) {
    const build = await run("npm", ["run", "build"], { cwd: process.cwd() });
    if (build.stdout) process.stdout.write(build.stdout);
    if (build.stderr) process.stderr.write(build.stderr);
    if (build.code !== 0) process.exit(build.code);
  }
  const suites = requested.length > 0 ? requested.map(normalizeSuite) : ALL_SUITES;
  let failures = 0;
  await clearDebugPort();
  for (const name of suites) {
    if (name === "worldline-preflight-test.mjs") {
      for (const testCase of PREFLIGHT_CASES) {
        console.log(`\n=== ${name} (${testCase}) ===`);
        const code = await runSuite(name, testCase);
        if (code !== 0) failures++;
      }
    } else {
      console.log(`\n=== ${name} ===`);
      const code = await runSuite(name);
      if (code !== 0) failures++;
    }
  }
  console.log(`\nE2E suites: ${suites.length - (suites.includes("worldline-preflight-test.mjs") ? 1 : 0) + (suites.includes("worldline-preflight-test.mjs") ? PREFLIGHT_CASES.length : 0) - failures} passed, ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
