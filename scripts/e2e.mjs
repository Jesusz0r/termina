import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { build as esbuildBuild } from "esbuild";
import { patchBundleName } from "./patch-bundle-name.mjs";
import { e2ePort } from "./e2e-port.mjs";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
let RUN_ROOT = "";
let BASE_ROOT = "";
let BASE_EVENTS = "";
let BASE_WORLDS = "";
let PREFLIGHT_ROOT = "";
let USER_DATA_ROOT = "";
let HOME_ROOT = "";
let CARGO_HOME_ROOT = "";
let promotionRootProvisioner = null;
const ownedChildren = new Set();
let shutdownStarted = false;
let cleanupPromise;

function testOnlyEnv(name) {
  const value = process.env[name];
  if (value !== undefined && process.env.NODE_ENV !== "test") {
    throw new Error(`${name} is only allowed with NODE_ENV=test`);
  }
  return value;
}

const testElectron = testOnlyEnv("TERMINA_E2E_TEST_ELECTRON");
const testFailSpawn = testOnlyEnv("TERMINA_E2E_TEST_FAIL_SPAWN");
const testReadyTimeout = testOnlyEnv("TERMINA_E2E_TEST_READY_TIMEOUT_MS");
const testStopFailure = testOnlyEnv("TERMINA_E2E_TEST_STOP_FAILURE");
const testSuiteTimeout = testOnlyEnv("TERMINA_E2E_TEST_SUITE_TIMEOUT_MS");
if (testFailSpawn !== undefined && !["build", "electron", "suite"].includes(testFailSpawn)) {
  throw new Error("TERMINA_E2E_TEST_FAIL_SPAWN must be build, electron, or suite");
}
if (testReadyTimeout !== undefined && (!/^\d+$/.test(testReadyTimeout) || Number(testReadyTimeout) < 1)) {
  throw new Error("TERMINA_E2E_TEST_READY_TIMEOUT_MS must be a positive integer");
}
if (testStopFailure !== undefined && !["build", "Electron", "suite"].includes(testStopFailure)) {
  throw new Error("TERMINA_E2E_TEST_STOP_FAILURE must be build, Electron, or suite");
}
if (testSuiteTimeout !== undefined && (!/^\d+$/.test(testSuiteTimeout) || Number(testSuiteTimeout) < 1)) {
  throw new Error("TERMINA_E2E_TEST_SUITE_TIMEOUT_MS must be a positive integer");
}
const SUITE_TIMEOUT_MS = testSuiteTimeout === undefined ? 10 * 60_000 : Number(testSuiteTimeout);
let injectedStopFailure = false;

function initializeRunPaths() {
  RUN_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "termina-e2e-")));
  BASE_ROOT = join(RUN_ROOT, "termina-test-project");
  BASE_EVENTS = join(RUN_ROOT, "termina-events-test");
  BASE_WORLDS = join(RUN_ROOT, "termina-worlds-test");
  PREFLIGHT_ROOT = join(RUN_ROOT, "termina-preflight");
  USER_DATA_ROOT = join(RUN_ROOT, "termina-e2e-user-data");
  HOME_ROOT = join(RUN_ROOT, "termina-e2e-home");
  CARGO_HOME_ROOT = join(RUN_ROOT, "termina-e2e-cargo-home");
}

const E2E_SESSION_ENV_KEYS = new Set([
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_CODING_AGENT",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "TERMINA_CORE_SESSION_FILE",
  "TERMINA_CORE_SESSION_ID",
  "TERMINA_CORE_RESUME",
  "TERMINA_AUTH_PATH",
  "SSH_AUTH_SOCK",
  "CARGO",
  "CARGO_HOME",
  "CARGO_TARGET_DIR",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTFLAGS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_userconfig",
]);

function isSensitiveE2eEnvKey(key) {
  return E2E_SESSION_ENV_KEYS.has(key)
    || key.startsWith("PI_SESSION_")
    || key.startsWith("GIT_CONFIG_")
    || /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SESSION_TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)$/.test(key);
}

function isolatedEnvironment(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !isSensitiveE2eEnvKey(key)) env[key] = value;
  }
  return {
    ...env,
    HOME: HOME_ROOT,
    USERPROFILE: HOME_ROOT,
    TERMINA_E2E_RUN_ROOT: RUN_ROOT,
    XDG_CONFIG_HOME: join(RUN_ROOT, "termina-e2e-xdg-config"),
    XDG_CACHE_HOME: join(RUN_ROOT, "termina-e2e-xdg-cache"),
    XDG_DATA_HOME: join(RUN_ROOT, "termina-e2e-xdg-data"),
    XDG_STATE_HOME: join(RUN_ROOT, "termina-e2e-xdg-state"),
    GIT_CONFIG_GLOBAL: join(RUN_ROOT, "termina-e2e-gitconfig"),
    NPM_CONFIG_USERCONFIG: join(RUN_ROOT, "termina-e2e-npmrc"),
    npm_config_userconfig: join(RUN_ROOT, "termina-e2e-npmrc"),
    ...overrides,
  };
}

function resolveExecutable(command, parentEnv = process.env) {
  const requested = typeof command === "string" ? command.trim() : "";
  if (!requested) return undefined;
  const candidates = requested.includes("/") || requested.includes("\\")
    ? [isAbsolute(requested) ? requested : resolve(requested)]
    : (parentEnv.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, requested));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching the parent-provided path entries.
    }
  }
  return undefined;
}

function trustedRustupHome(parentEnv = process.env) {
  const explicit = parentEnv.RUSTUP_HOME?.trim();
  if (explicit) return explicit;
  const parentHome = parentEnv.HOME?.trim();
  const defaultHome = parentHome ? join(parentHome, ".rustup") : "";
  return defaultHome && existsSync(defaultHome) ? defaultHome : undefined;
}

function buildEnvironment() {
  const cargo = resolveExecutable(process.env.CARGO || "cargo");
  const skipCoreBuild = process.env.TERMINA_SKIP_CORE_BUILD === "1"
    && existsSync(join(process.cwd(), "dist-electron", "termina-core"));
  if (!cargo && !skipCoreBuild) {
    throw new Error("E2E core build cannot start: Cargo executable was not found; install Rust/cargo or set CARGO to a trusted executable");
  }
  const cargoBin = cargo ? dirname(cargo) : "";
  const parentPath = process.env.PATH ?? "";
  const toolchainPath = cargoBin && !parentPath.split(delimiter).includes(cargoBin)
    ? `${cargoBin}${delimiter}${parentPath}`
    : parentPath;
  const rustupHome = trustedRustupHome();
  return isolatedEnvironment({
    ...(cargo ? { CARGO: cargo } : {}),
    CARGO_HOME: CARGO_HOME_ROOT,
    ...(rustupHome ? { RUSTUP_HOME: rustupHome } : {}),
    ...(process.env.RUSTUP_TOOLCHAIN ? { RUSTUP_TOOLCHAIN: process.env.RUSTUP_TOOLCHAIN } : {}),
    PATH: toolchainPath,
  });
}

function installOwnedShutdownHandlers() {
  const shutdown = (signal, exitCode) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void (async () => {
      await cleanupRun();
      process.exit(exitCode);
    })().catch((error) => {
      console.error(`E2E ${signal} cleanup failed: ${error instanceof Error ? error.message : error}`);
      process.exit(exitCode);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT", 130));
  process.on("SIGTERM", () => shutdown("SIGTERM", 143));
  process.on("SIGHUP", () => shutdown("SIGHUP", 129));
}

function registerOwnedChild(child, { label, processGroup = false }) {
  let resolveClosed;
  let resolveTerminal;
  let terminalSettled = false;
  const record = {
    child,
    label,
    processGroup,
    groupId: processGroup && process.platform !== "win32" ? child.pid : undefined,
    groupSettled: !processGroup || process.platform === "win32" || !child.pid,
    exited: false,
    closed: false,
    spawnError: undefined,
    stopPromise: undefined,
    closedPromise: new Promise((resolve) => { resolveClosed = resolve; }),
    terminalPromise: new Promise((resolve) => { resolveTerminal = resolve; }),
  };
  const settleTerminal = (outcome) => {
    if (terminalSettled) return;
    terminalSettled = true;
    resolveTerminal(outcome);
  };
  child.once("error", (error) => {
    record.spawnError = error;
    settleTerminal({ type: "error", error });
  });
  child.once("exit", () => {
    record.exited = true;
  });
  child.once("close", (code, signal) => {
    record.closed = true;
    settleTerminal({ type: "close", code, signal });
    resolveClosed({ code, signal });
    // A detached leader can close while descendants remain in its process
    // group. Keep the record until the group itself is gone so shutdown can
    // still signal those descendants.
    if (record.groupSettled) ownedChildren.delete(record);
  });
  ownedChildren.add(record);
  return record;
}

function spawnOwned(label, command, args, options, { processGroup = false } = {}) {
  if (shutdownStarted) throw new Error(`cannot start ${label} during E2E shutdown`);
  const child = spawn(command, args, options);
  return registerOwnedChild(child, { label, processGroup });
}

function spawnOwnedRole(role, label, command, args, options, ownership) {
  if (testFailSpawn === role) {
    return spawnOwned(label, join(RUN_ROOT, `.missing-${role}-executable`), [], options, ownership);
  }
  return spawnOwned(label, command, args, options, ownership);
}

async function waitForOwnedExit(record) {
  const outcome = await record.terminalPromise;
  if (outcome.type === "error") {
    throw new Error(`${record.label} failed to spawn: ${outcome.error instanceof Error ? outcome.error.message : outcome.error}`);
  }
  return outcome.code ?? 1;
}

async function waitForSuite(record) {
  let timer;
  try {
    return await Promise.race([
      waitForOwnedExit(record),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${record.label} timed out after ${SUITE_TIMEOUT_MS}ms`)), SUITE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function spawnCommandOwned(label, command, args, options = {}) {
  if (shutdownStarted) throw new Error(`cannot start ${label} during E2E shutdown`);
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const { input, stdio, ...spawnOptions } = options;
  const child = spawn(command, args, {
    ...spawnOptions,
    stdio: stdio ?? ["pipe", "pipe", "pipe"],
    ...(process.platform !== "win32" ? { detached: true } : {}),
  });
  const record = registerOwnedChild(child, { label, processGroup: process.platform !== "win32" });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  if (child.stdin) child.stdin.end(input);
  record.terminalPromise.then((outcome) => {
    if (outcome.type === "error") {
      resolveCompletion({ error: outcome.error, stdout, stderr });
      return;
    }
    if (outcome.code === 0 && outcome.signal === null) {
      resolveCompletion({ error: null, stdout, stderr });
      return;
    }
    const error = new Error(`${label} exited with ${outcome.signal ?? `code ${outcome.code ?? 1}`}`);
    error.code = outcome.code ?? 1;
    if (outcome.signal) error.signal = outcome.signal;
    resolveCompletion({ error, stdout, stderr });
  });
  return { record, completion };
}

const BASIC_SUITES = [
  "explorer-test.mjs",
  "preview-test.mjs",
  "editor-tabs-test.mjs",
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
  "multiproj-test.mjs",
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
    const runOptions = {
      ...options,
      env: isolatedEnvironment(options.env ?? {}),
    };
    const { record, completion } = spawnCommandOwned(`${command} ${args.join(" ")}`, command, args, runOptions);
    const result = await completion;
    await record.closedPromise;
    return {
      code: result.error ? (result.error.code ?? 1) : 0,
      stdout: result.stdout,
      stderr: result.stderr || (result.error ? String(result.error.message ?? result.error) : ""),
    };
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

async function ensureFixturePromotionRoots(worldsRoot, primaryRoot) {
  if (!promotionRootProvisioner) {
    const bundle = join(RUN_ROOT, "termina-e2e-worldlines.mjs");
    await esbuildBuild({
      entryPoints: ["electron/worldlines.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: bundle,
      logLevel: "silent",
    });
    const module = await import(pathToFileURL(bundle).href);
    if (typeof module.ensurePromotionRoots !== "function" || typeof module.disposeWorldlineCoreClient !== "function") {
      throw new Error("worldline fixture provenance API is unavailable");
    }
    promotionRootProvisioner = {
      ensure: module.ensurePromotionRoots,
      dispose: module.disposeWorldlineCoreClient,
    };
  }
  await promotionRootProvisioner.ensure(worldsRoot, primaryRoot);
}

/** Reset both fixture roots, then create their persisted current-format bind. */
async function resetFixtureRoots(worldsRoot, primaryRoot) {
  await rm(worldsRoot, { recursive: true, force: true });
  await rm(primaryRoot, { recursive: true, force: true });
  await mkdir(dirname(worldsRoot), { recursive: true });
  await mkdir(dirname(primaryRoot), { recursive: true });
  await ensureFixturePromotionRoots(worldsRoot, primaryRoot);
}

async function createGitRepo(root, files, { preserveRoot = false } = {}) {
  if (preserveRoot) await mkdir(root, { recursive: true });
  else await reset(root);
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "e2e@termina.local"]);
  await git(root, ["config", "user.name", "termina e2e"]);
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
    const root = join(RUN_ROOT, "termina-verify-project");
    await resetFixtureRoots(BASE_WORLDS, root);
    await put(root, "package.json", JSON.stringify({ name: "verify-fixture", scripts: { test: "node test.js" } }) + "\n");
    await put(root, "math.js", "exports.add = (a, b) => a + b + 1; // BUG\n");
    await put(root, "test.js", "const { add } = require('./math');\nif (add(2, 3) !== 5) { console.error('FAIL: add'); process.exit(1); }\n");
    return { root, events: join(RUN_ROOT, "termina-verify-events"), worlds: BASE_WORLDS };
  }
  if (name === "verify-cancel-test.mjs") {
    await resetFixtureRoots(BASE_WORLDS, BASE_ROOT);
    await put(BASE_ROOT, "greeting.ts", 'export const greeting = "hello";\n');
    await put(BASE_ROOT, "package.json", JSON.stringify({ name: "cancel-fixture", scripts: { test: "node -e \"setTimeout(() => {}, 30000)\"" } }) + "\n");
    return { root: BASE_ROOT, events: BASE_EVENTS, worlds: BASE_WORLDS };
  }
  await resetFixtureRoots(BASE_WORLDS, BASE_ROOT);
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
  if (suffix === undefined) throw new Error(`unknown worldline suite: ${name}`);
  return {
    root: join(RUN_ROOT, `termina-wline${suffix}-project`),
    events: join(RUN_ROOT, `termina-wline${suffix}-events`),
    worlds: join(RUN_ROOT, `termina-wline${suffix}-worlds`),
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
  await resetFixtureRoots(paths.worlds, paths.root);
  await createGitRepo(paths.root, files, { preserveRoot: true });
  await reset(paths.events);
  return paths;
}

async function seedRecovery(root, worlds) {
  const journalRoot = join(worlds, "promotion-journal");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const before = 'export const greeting = "hello";\n';
  const applied = 'export const greeting = "applied";\n';
  await put(root, "greeting.ts", applied);
  await put(root, "other.txt", "done-state\n");
  await put(root, "conflict.txt", "external\n");
  const appliedDir = join(journalRoot, "recovery-1");
  await put(appliedDir, "before/greeting.ts", before);
  await put(appliedDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{ rel: "greeting.ts", kind: "write", beforeHash: hash(before), afterHash: hash(applied), beforeExists: true }],
  }));
  await put(join(journalRoot, "recovery-2"), "journal.json", JSON.stringify({ phase: "done", primaryRoot: root, paths: [] }));
  const conflictDir = join(journalRoot, "recovery-3");
  await put(conflictDir, "before/conflict.txt", "before\n");
  await put(conflictDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{ rel: "conflict.txt", kind: "write", beforeHash: hash("before\n"), afterHash: hash("applied\n"), beforeExists: true }],
  }));

  const preparedDir = join(journalRoot, "recovery-4");
  await put(root, "prepared-first.txt", "applied-first\n");
  await put(root, "prepared-second.txt", "before-second\n");
  await put(preparedDir, "before/prepared-first.txt", "before-first\n");
  await put(preparedDir, "before/prepared-second.txt", "before-second\n");
  await put(preparedDir, "journal.json", JSON.stringify({
    phase: "prepared",
    primaryRoot: root,
    paths: [
      { rel: "prepared-first.txt", kind: "write", beforeHash: hash("before-first\n"), afterHash: hash("applied-first\n"), beforeExists: true },
      { rel: "prepared-second.txt", kind: "write", beforeHash: hash("before-second\n"), afterHash: hash("applied-second\n"), beforeExists: true },
    ],
  }));

  const applyingDir = join(journalRoot, "recovery-5");
  await put(root, "applying-first.txt", "applied-first\n");
  await put(root, "applying-second.txt", "before-second\n");
  await put(applyingDir, "before/applying-first.txt", "before-first\n");
  await put(applyingDir, "before/applying-second.txt", "before-second\n");
  await put(applyingDir, "journal.json", JSON.stringify({
    phase: "applying",
    primaryRoot: root,
    paths: [
      { rel: "applying-first.txt", kind: "write", beforeHash: hash("before-first\n"), afterHash: hash("applied-first\n"), beforeExists: true },
      { rel: "applying-second.txt", kind: "write", beforeHash: hash("before-second\n"), afterHash: hash("applied-second\n"), beforeExists: true },
    ],
  }));

  const preparedConflictDir = join(journalRoot, "recovery-6");
  await put(root, "prepared-conflict.txt", "external\n");
  await put(preparedConflictDir, "before/prepared-conflict.txt", "before\n");
  await put(preparedConflictDir, "journal.json", JSON.stringify({
    phase: "prepared",
    primaryRoot: root,
    paths: [{ rel: "prepared-conflict.txt", kind: "write", beforeHash: hash("before\n"), afterHash: hash("applied\n"), beforeExists: true }],
  }));

  const outside = `${root}-outside`;
  await reset(outside);
  await put(outside, "touched.ts", "applied-outside\n");
  await rm(join(root, "redirect"), { recursive: true, force: true });
  await symlink(outside, join(root, "redirect"), "dir");
  const unsafeDir = join(journalRoot, "recovery-7");
  await put(unsafeDir, "before/redirect/touched.ts", "before-outside\n");
  await put(unsafeDir, "before/redirect/missing.ts", "before-missing\n");
  await put(unsafeDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [
      { rel: "redirect/touched.ts", kind: "write", beforeHash: hash("before-outside\n"), afterHash: hash("applied-outside\n"), beforeExists: true },
      { rel: "redirect/missing.ts", kind: "delete", beforeHash: hash("before-missing\n"), afterHash: hash(""), beforeExists: true },
    ],
  }));

  await put(join(journalRoot, "recovery-8"), "journal.json", "{not-json");

  const corruptBeforeDir = join(journalRoot, "recovery-9");
  await put(root, "corrupt-before.txt", "applied\n");
  await put(corruptBeforeDir, "before/corrupt-before.txt", "corrupt\n");
  await put(corruptBeforeDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{
      rel: "corrupt-before.txt",
      kind: "write",
      beforeHash: hash("before\n"),
      afterHash: hash("applied\n"),
      beforeExists: true,
      beforeState: { type: "file", mode: 0o644, hash: hash("before\n") },
      afterState: { type: "file", mode: 0o644, hash: hash("applied\n") },
    }],
  }));

  const missingVsZeroDir = join(journalRoot, "recovery-10");
  await put(root, "missing-vs-zero.txt", "");
  await put(missingVsZeroDir, "before/missing-vs-zero.txt", "before\n");
  await put(missingVsZeroDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{
      rel: "missing-vs-zero.txt",
      kind: "delete",
      beforeHash: hash("before\n"),
      afterHash: hash(""),
      beforeExists: true,
      beforeState: { type: "file", mode: 0o644, hash: hash("before\n") },
      afterState: { type: "missing" },
    }],
  }));

  const symlinkDir = join(journalRoot, "recovery-11");
  await put(root, "symlink-state", "applied\n");
  await put(symlinkDir, "before/symlink-state", "greeting.ts");
  await put(symlinkDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{
      rel: "symlink-state",
      kind: "write",
      beforeHash: hash("greeting.ts"),
      afterHash: hash("applied\n"),
      beforeExists: true,
      beforeState: { type: "symlink", target: "greeting.ts" },
      afterState: { type: "file", mode: 0o644, hash: hash("applied\n") },
    }],
  }));

  const modeDir = join(journalRoot, "recovery-12");
  await put(root, "mode-state.sh", "applied\n");
  await chmod(join(root, "mode-state.sh"), 0o644);
  await put(modeDir, "before/mode-state.sh", "before\n");
  await chmod(join(modeDir, "before/mode-state.sh"), 0o755);
  await put(modeDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{
      rel: "mode-state.sh",
      kind: "write",
      beforeHash: hash("before\n"),
      afterHash: hash("applied\n"),
      beforeExists: true,
      beforeState: { type: "file", mode: 0o755, hash: hash("before\n") },
      afterState: { type: "file", mode: 0o644, hash: hash("applied\n") },
    }],
  }));

  const directoryConflictDir = join(journalRoot, "recovery-13");
  await rm(join(root, "directory-conflict"), { recursive: true, force: true });
  await mkdir(join(root, "directory-conflict"));
  await put(directoryConflictDir, "before/directory-conflict", "before\n");
  await put(directoryConflictDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{
      rel: "directory-conflict",
      kind: "write",
      beforeHash: hash("before\n"),
      afterHash: hash("applied\n"),
      beforeExists: true,
      beforeState: { type: "file", mode: 0o644, hash: hash("before\n") },
      afterState: { type: "file", mode: 0o644, hash: hash("applied\n") },
    }],
  }));

  const afterConflictDir = join(journalRoot, "recovery-14");
  await put(root, "after-conflict.txt", "applied\n");
  await put(afterConflictDir, "before/after-conflict.txt", "before\n");
  await put(afterConflictDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{
      rel: "after-conflict.txt",
      kind: "write",
      beforeHash: hash("before\n"),
      afterHash: hash("applied\n"),
      beforeExists: true,
      beforeState: { type: "file", mode: 0o644, hash: hash("before\n") },
      afterState: { type: "file", mode: 0o644, hash: hash("applied\n") },
    }],
  }));

  const missingBeforeExistsDir = join(journalRoot, "recovery-15");
  await put(root, "missing-before-exists.txt", "applied\n");
  await put(missingBeforeExistsDir, "before/missing-before-exists.txt", "before\n");
  await put(missingBeforeExistsDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{
      rel: "missing-before-exists.txt",
      kind: "write",
      beforeHash: hash("before\n"),
      afterHash: hash("applied\n"),
    }],
  }));

  const duplicateDir = join(journalRoot, "recovery-16");
  await put(root, "duplicate-path.txt", "applied\n");
  await put(duplicateDir, "before/duplicate-path.txt", "before\n");
  const duplicatePath = {
    rel: "duplicate-path.txt",
    kind: "write",
    beforeHash: hash("before\n"),
    afterHash: hash("applied\n"),
    beforeExists: true,
  };
  await put(duplicateDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [duplicatePath, duplicatePath],
  }));

  const ambiguousDir = join(journalRoot, "recovery-17");
  await put(root, "ambiguous-empty.txt", "");
  await put(ambiguousDir, "before/ambiguous-empty.txt", "before\n");
  await put(ambiguousDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [{
      rel: "ambiguous-empty.txt",
      beforeHash: hash("before\n"),
      afterHash: hash(""),
      beforeExists: true,
    }],
  }));

  const validateAllDir = join(journalRoot, "recovery-18");
  await put(root, "schema-order.txt", "applied\n");
  await put(validateAllDir, "before/schema-order.txt", "before\n");
  await put(validateAllDir, "journal.json", JSON.stringify({
    phase: "applied",
    primaryRoot: root,
    paths: [
      {
        rel: "schema-order.txt",
        kind: "write",
        beforeHash: hash("before\n"),
        afterHash: hash("applied\n"),
        beforeExists: true,
      },
      {
        rel: "../schema-outside.txt",
        kind: "write",
        beforeHash: hash("before\n"),
        afterHash: hash("applied\n"),
        beforeExists: true,
      },
    ],
  }));
}

async function seedCleanup(worlds) {
  const stale = join(worlds, "stale-cmp");
  await put(stale, ".termina-world", "owned\n");
  await put(stale, "manifest.json", JSON.stringify({ candidates: { A: { pid: 999999, lstart: "0" } } }));
  await put(worlds, "foreign-dir/keep.txt", "keep\n");
}

async function preparePreflight(testCase) {
  const root = join(PREFLIGHT_ROOT, testCase === "nogit" ? "nogit" : "repo");
  const worlds = join(PREFLIGHT_ROOT, `worlds-${testCase}`);
  const primary = testCase === "subdir" ? join(root, "subdir") : root;
  const files = baseFiles();
  if (testCase === "conflict") files["conflict-file.txt"] = "conflict\n";
  if (testCase === "submodule") files["submodule.txt"] = "submodule\n";
  await resetFixtureRoots(worlds, primary);
  await createGitRepo(root, files, { preserveRoot: true });
  if (testCase === "nogit") {
    await rm(join(root, ".git"), { recursive: true, force: true });
    return { root, events: join(PREFLIGHT_ROOT, "events-nogit"), worlds };
  }
  if (testCase === "subdir") {
    await put(root, "subdir/greeting.ts", 'export const greeting = "hello";\n');
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "subdir"]);
    return { root: primary, events: join(PREFLIGHT_ROOT, "events-subdir"), worlds };
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
  return { root, events: join(PREFLIGHT_ROOT, `events-${testCase}`), worlds };
}

async function prepare(name, testCase) {
  if (name === "worldline-preflight-test.mjs") return preparePreflight(testCase);
  if (WORLDLINE_SUITES.includes(name)) return prepareWorldline(name);
  return prepareBasic(name);
}

async function waitForRemoteDebugging(userData, app) {
  const activePortPath = join(userData, "DevToolsActivePort");
  const deadline = Date.now() + (testReadyTimeout === undefined ? 90_000 : Number(testReadyTimeout));
  const cancellation = new AbortController();
  app.terminalPromise.then(() => cancellation.abort());
  let lastError = "DevToolsActivePort has not been created";
  const throwIfStopped = () => {
    if (app.spawnError) {
      throw new Error(`Electron failed to spawn: ${app.spawnError instanceof Error ? app.spawnError.message : app.spawnError}`);
    }
    if (app.exited || app.closed || app.child.exitCode !== null || app.child.signalCode !== null) {
      const code = app.child.exitCode;
      const signal = app.child.signalCode;
      throw new Error(`Electron exited with ${signal ?? `code ${code}`} before opening DevTools`);
    }
  };

  while (Date.now() < deadline) {
    throwIfStopped();
    try {
      const contents = await readFile(activePortPath, "utf8");
      const port = e2ePort({ TERMINA_E2E_PORT: contents.split(/\r?\n/, 1)[0] });
      const remaining = Math.max(1, deadline - Date.now());
      const response = await fetchWithTimeout(
        `http://127.0.0.1:${port}/json`,
        cancellation.signal,
        Math.min(1_000, remaining),
      );
      if (response.ok) return port;
      lastError = `DevTools returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    throwIfStopped();
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await waitForDelay(Math.min(250, remaining), cancellation.signal);
    }
  }
  throwIfStopped();
  throw new Error(`Electron did not publish a usable DevTools port: ${lastError}`);
}

async function fetchWithTimeout(url, parentSignal, timeoutMs) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: AbortSignal.any([parentSignal, timeoutController.signal]) });
  } finally {
    clearTimeout(timeout);
  }
}

function waitForDelay(delayMs, signal) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    if (signal.aborted) {
      finish();
      return;
    }
    timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function waitForOwnedClose(record, timeoutMs) {
  if (record.closed) return true;
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    record.closedPromise.then(() => finish(true));
  });
}

function ownedProcessGroupExists(record) {
  if (!record.processGroup || process.platform === "win32" || record.groupSettled) return false;
  const groupId = record.groupId ?? record.child.pid;
  if (!groupId) {
    record.groupSettled = true;
    if (record.closed) ownedChildren.delete(record);
    return false;
  }
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      record.groupSettled = true;
      if (record.closed) ownedChildren.delete(record);
      return false;
    }
    // EPERM still means that a process group exists. The group was created by
    // this runner and must not be treated as settled just because it cannot be
    // probed with signal 0.
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForOwnedGroupGone(record, timeoutMs) {
  if (!record.processGroup || process.platform === "win32") return waitForOwnedClose(record, timeoutMs);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!ownedProcessGroupExists(record)) {
      // Group disappearance is necessary but not sufficient: wait for Node
      // to observe the owned leader's close as well, otherwise process.exit
      // can leave a just-exited child unreaped.
      return waitForOwnedClose(record, Math.max(1, deadline - Date.now()));
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(20, deadline - Date.now())));
  }
  if (ownedProcessGroupExists(record)) return false;
  return waitForOwnedClose(record, Math.max(1, deadline - Date.now()));
}

function signalOwnedChild(record, signal) {
  const { child } = record;
  if (record.processGroup && process.platform !== "win32") {
    if (!ownedProcessGroupExists(record)) return false;
    try {
      process.kill(-(record.groupId ?? child.pid), signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        record.groupSettled = true;
        if (record.closed) ownedChildren.delete(record);
        return false;
      }
      throw error;
    }
  }
  if (record.closed || !child.pid) return false;
  if (record.exited || child.exitCode !== null || child.signalCode !== null) return false;
  return child.kill(signal);
}

async function stopOwnedChild(record) {
  const processGroup = record?.processGroup && process.platform !== "win32";
  if (!record || (!processGroup && record.closed)) return;
  if (record.stopPromise) return record.stopPromise;
  record.stopPromise = (async () => {
    const injectFailure = () => {
      if (shutdownStarted && testStopFailure === record.label && !injectedStopFailure) {
        injectedStopFailure = true;
        throw new Error(`injected stop failure for ${record.label}`);
      }
    };
    try {
      signalOwnedChild(record, "SIGTERM");
    } catch {
      // The owned child can finish between the liveness check and signal.
    }
    const termStopped = processGroup
      ? await waitForOwnedGroupGone(record, 1500)
      : await waitForOwnedClose(record, 1500);
    if (termStopped) {
      injectFailure();
      return;
    }
    try {
      signalOwnedChild(record, "SIGKILL");
    } catch {
      // The owned child/group exited between the liveness check and signal.
    }
    const killStopped = processGroup
      ? await waitForOwnedGroupGone(record, 5000)
      : await waitForOwnedClose(record, 5000);
    if (!killStopped) {
      throw new Error(processGroup
        ? `${record.label} process group did not disappear after SIGKILL`
        : `${record.label} did not close after SIGKILL`);
    }
    injectFailure();
  })();
  return record.stopPromise;
}

async function stopAllOwnedChildren() {
  const results = await Promise.allSettled([...ownedChildren].map((record) => stopOwnedChild(record)));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, "failed to stop all owned E2E children");
}

async function cleanupRun() {
  cleanupPromise ??= (async () => {
    const failures = [];
    try {
      await stopAllOwnedChildren();
    } catch (error) {
      failures.push(error);
    }
    try {
      promotionRootProvisioner?.dispose();
      promotionRootProvisioner = null;
    } catch (error) {
      failures.push(error);
    }
    try {
      if (RUN_ROOT) await rm(RUN_ROOT, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw failures.length === 1 ? failures[0] : new AggregateError(failures, "E2E cleanup failed");
    }
  })();
  return cleanupPromise;
}

/** Restore term-1 as Pi so agent-driving suites keep the existing term-1 contract. */
async function seedPiRoster(userData, cwd) {
  let abs = cwd;
  try {
    abs = await realpath(cwd);
  } catch {
    /* keep cwd */
  }
  const slug = `--${abs.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "").replace(/[/\\:]/g, "-")}--`;
  const dir = join(userData, "terminal-rosters");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${slug}.json`), `${JSON.stringify({ terminals: [{ id: "term-1", type: "agent", engine: "pi" }] })}\n`);
}

async function runSuite(name, testCase) {
  const fixture = await prepare(name, testCase);
  await rm(fixture.events, { recursive: true, force: true });
  await mkdir(fixture.events, { recursive: true });
  const userData = join(USER_DATA_ROOT, `${name.replace(/[^a-z0-9-]/gi, "-")}${testCase ? `-${testCase}` : ""}`);
  await rm(userData, { recursive: true, force: true });
  await mkdir(userData, { recursive: true });
  await mkdir(join(HOME_ROOT, ".pi", "agent"), { recursive: true });
  await seedPiRoster(userData, fixture.root);
  if (name === "worldline-recovery-test.mjs") await seedRecovery(fixture.root, fixture.worlds);
  if (name === "worldline-cleanup-test.mjs") await seedCleanup(fixture.worlds);

  const env = isolatedEnvironment({
    TERMINA_INITIAL_CWD: fixture.root,
    TERMINA_EVENTS_DIR: fixture.events,
    TERMINA_WORLDS_DIR: fixture.worlds,
    TERMINA_USER_DATA_DIR: userData,
    TERMINA_E2E_RUN_ROOT: RUN_ROOT,
  });
  delete env.TERMINA_E2E_PORT;
  if (testCase) env.PREFLIGHT_CASE = testCase;
  if (!testElectron) patchBundleName();
  const electronArgs = [
    ".",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${userData}`,
  ];
  const app = testElectron
    ? spawnOwnedRole("electron", "Electron", process.execPath, [testElectron, ...electronArgs], { env, detached: true, stdio: "inherit" }, { processGroup: true })
    : spawnOwnedRole("electron", "Electron", electronPath, electronArgs, { env, detached: true, stdio: "inherit" }, { processGroup: true });
  let test;
  try {
    const port = await waitForRemoteDebugging(userData, app);
    const suiteEnv = { ...env, TERMINA_E2E_PORT: String(port) };
    const testReadyDelay = process.env.NODE_ENV === "test"
      ? Number(process.env.TERMINA_E2E_TEST_READY_DELAY_MS ?? 6000)
      : 6000;
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(testReadyDelay) ? Math.max(0, testReadyDelay) : 6000));
    test = spawnOwnedRole("suite", `suite ${name}`, process.execPath, [join(process.cwd(), "scripts", name)], { env: suiteEnv, detached: true, stdio: "inherit" }, { processGroup: true });
    return await waitForSuite(test);
  } finally {
    await stopAllOwnedChildren();
  }
}

async function main() {
  initializeRunPaths();
  installOwnedShutdownHandlers();
  try {
    const args = process.argv.slice(2);
    const requested = args.filter((arg) => !arg.startsWith("--"));
    const skipBuild = args.includes("--skip-build");
    if (!skipBuild) {
      if (testFailSpawn !== "build") await mkdir(CARGO_HOME_ROOT, { recursive: true });
      const build = spawnOwnedRole("build", "build", "npm", ["run", "build"], {
        cwd: process.cwd(),
        detached: true,
        env: testFailSpawn === "build" ? isolatedEnvironment() : buildEnvironment(),
        stdio: "inherit",
      }, { processGroup: true });
      const buildCode = await waitForOwnedExit(build);
      if (buildCode !== 0) return buildCode;
      if (shutdownStarted) return 1;
    }
    const suites = requested.length > 0 ? requested.map(normalizeSuite) : ALL_SUITES;
    let failures = 0;
    for (const name of suites) {
      if (name === "worldline-preflight-test.mjs") {
        for (const testCase of PREFLIGHT_CASES) {
          console.log(`\n=== ${name} (${testCase}) ===`);
          const code = await runSuite(name, testCase);
          if (code !== 0) failures++;
          if (shutdownStarted) return 1;
        }
      } else {
        console.log(`\n=== ${name} ===`);
        const code = await runSuite(name);
        if (code !== 0) failures++;
        if (shutdownStarted) return 1;
      }
    }
    console.log(`\nE2E suites: ${suites.length - (suites.includes("worldline-preflight-test.mjs") ? 1 : 0) + (suites.includes("worldline-preflight-test.mjs") ? PREFLIGHT_CASES.length : 0) - failures} passed, ${failures} failed`);
    return failures === 0 ? 0 : 1;
  } finally {
    await cleanupRun();
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch(async (error) => {
  shutdownStarted = true;
  console.error(error instanceof Error ? error.message : error);
  try {
    await cleanupRun();
  } catch (cleanupError) {
    console.error(`E2E error cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`);
  }
  process.exitCode = 1;
});
