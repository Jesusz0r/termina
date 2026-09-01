import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "termina-auth-lock-"));
const authPath = join(root, "auth.json");
const lockPath = `${authPath}.lock`;
const authModule = pathToFileURL(resolve("agent-core/auth.ts")).href;
const baseline = '{\n  "anthropic": { "type": "api_key", "key": "before" }\n}\n';
const activeChildren = new Set();

function processIdentity(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(") ");
      if (commandEnd >= 0) {
        const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
        const startTicks = fieldsAfterCommand[19];
        const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        if (/^\d+$/.test(startTicks) && /^[a-f0-9-]{36}$/.test(bootId)) {
          return `linux:${bootId}:${startTicks}`;
        }
      }
    } catch {
      // A dead fixture process has no observable identity; its pid is enough
      // for the dead-owner recovery path.
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      maxBuffer: 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && result.stdout.trim() !== "") {
      return `darwin:${result.stdout.trim().replace(/\s+/g, " ")}`;
    }
  }
  return `test-unknown:${pid}`;
}

process.on("exit", () => rmSync(root, { recursive: true, force: true }));

function trackChild(child, label) {
  const handle = { child, label, done: once(child, "close") };
  activeChildren.add(handle);
  return handle;
}

async function waitChild(handle) {
  let timeout;
  try {
    const result = await Promise.race([
      handle.done,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${handle.label} did not exit before the test deadline`)), 15_000);
      }),
    ]);
    activeChildren.delete(handle);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function stopChild(handle) {
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    try {
      handle.child.kill("SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await waitChild(handle);
}

async function stopActiveChildren() {
  await Promise.allSettled([...activeChildren].map((handle) => stopChild(handle)));
}

function ownerRecordPath() {
  const entry = readdirSync(lockPath).find((name) => name.startsWith(".record-"));
  assert.ok(entry, "lock has no owner record");
  return join(lockPath, entry);
}

function writeDirectoryLock(value, { holdWitness = false } = {}) {
  mkdirSync(lockPath, { mode: 0o700 });
  const directory = lstatSync(lockPath);
  if (typeof value === "string") {
    const token = "malformed-fixture";
    writeFileSync(join(lockPath, `.record-${token}-${directory.dev}-${directory.ino}`), value, { mode: 0o600 });
    mkdirSync(join(lockPath, `.owner-${token}-${directory.dev}-${directory.ino}`), { mode: 0o700 });
    return;
  }
  const owner = { processIdentity: processIdentity(value.pid), ...value, dev: directory.dev, ino: directory.ino };
  writeFileSync(join(lockPath, `.record-${owner.token}-${owner.dev}-${owner.ino}`), JSON.stringify(owner), { mode: 0o600 });
  const guard = join(lockPath, `.owner-${owner.token}-${owner.dev}-${owner.ino}`);
  mkdirSync(guard, { mode: 0o700 });
  const witness = join(guard, "witness");
  execFileSync("/usr/bin/mkfifo", ["-m", "0600", witness], { stdio: "ignore" });
  if (holdWitness) {
    return openSync(witness, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
  }
  return null;
}

function childCode() {
  return `
    import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const authPath = process.env.TERMINA_AUTH_PATH;
    const lockPath = authPath + ".lock";
    const mode = process.env.TERMINA_AUTH_LOCK_MODE || "normal";
    if (process.env.TERMINA_AUTH_LOCK_EPERM === "1") {
      process.kill = () => {
        const error = new Error("permission denied");
        error.code = "EPERM";
        throw error;
      };
    }
    if (process.env.TERMINA_AUTH_LOCK_UNKNOWN === "1") {
      process.kill = () => {};
    }
    if (mode === "pause-after-stale-inspection") {
      const realKill = process.kill.bind(process);
      let paused = false;
      process.kill = (pid, signal) => {
        if (!paused && signal === 0) {
          paused = true;
          writeFileSync(process.env.TERMINA_AUTH_LOCK_INSPECTED, "inspected");
          while (!existsSync(process.env.TERMINA_AUTH_LOCK_RESUME)) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        return realKill(pid, signal);
      };
    }
    if (mode === "concurrent") {
      while (!existsSync(process.env.TERMINA_AUTH_LOCK_START)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const { modifyProvider } = await import(${JSON.stringify(authModule)});
    try {
      modifyProvider(process.env.TERMINA_AUTH_LOCK_PROVIDER || "anthropic", () => {
        if (mode === "same-token-directory-replacement") {
          const ownerEntry = readdirSync(lockPath).find((name) => name.startsWith(".record-"));
          const owner = readFileSync(join(lockPath, ownerEntry), "utf8");
          const parsed = JSON.parse(owner);
          rmSync(lockPath, { recursive: true, force: true });
          mkdirSync(lockPath, { mode: 0o700 });
          writeFileSync(join(lockPath, ownerEntry), owner, { mode: 0o600 });
          mkdirSync(join(lockPath, ".owner-" + parsed.token + "-" + parsed.dev + "-" + parsed.ino), { mode: 0o700 });
        }
        if (mode === "concurrent") {
          writeFileSync(join(process.env.TERMINA_AUTH_LOCK_ENTERED, String(process.pid)), "entered");
          while (!existsSync(process.env.TERMINA_AUTH_LOCK_RELEASE)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        if (mode === "crash-after-entered") {
          writeFileSync(process.env.TERMINA_AUTH_LOCK_ENTERED, String(process.pid));
          process.kill(process.pid, "SIGKILL");
        }
        return { type: "api_key", key: process.env.TERMINA_AUTH_LOCK_KEY || "after" };
      });
      console.log(JSON.stringify({ ok: true }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  `;
}

function contender(options = {}) {
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", childCode()], {
    cwd: resolve("."),
    env: { ...process.env, TERMINA_CORE_TEST: "1", TERMINA_AUTH_PATH: authPath, ...options },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(child.error, undefined, `contender failed to start: ${child.error?.message ?? "unknown error"}`);
  assert.equal(child.status, 0, `contender exited ${child.status}: ${child.stderr}`);
  return JSON.parse(child.stdout.trim());
}

function startContender(options) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", childCode()], {
    cwd: resolve("."),
    env: { ...process.env, TERMINA_CORE_TEST: "1", TERMINA_AUTH_PATH: authPath, ...options },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const handle = trackChild(child, "auth-lock contender");
  return {
    async result() {
      const [code] = await waitChild(handle);
      assert.equal(code, 0, `concurrent contender exited ${code}: ${stderr}`);
      return JSON.parse(stdout.trim());
    },
    async termination() {
      return waitChild(handle);
    },
    async stop() {
      await stopChild(handle);
    },
  };
}

function waitFor(check, message) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function resetAuth() {
  rmSync(lockPath, { recursive: true, force: true });
  writeFileSync(authPath, baseline, { mode: 0o600 });
}

async function crashRecoveryCase(stage, stale) {
  resetAuth();
  if (stale) {
    const staleOwner = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    assert.equal(staleOwner.status, 0);
    writeDirectoryLock({ pid: Number(staleOwner.stdout), token: `crash-${stage}`, startedAt: 1 });
  }
  const crashed = startContender({
    TERMINA_AUTH_LOCK_CRASH: stage,
    TERMINA_AUTH_LOCK_PROVIDER: stale ? "openai" : "anthropic",
    TERMINA_AUTH_LOCK_KEY: "crashed",
  });
  const [code, signal] = await crashed.termination();
  assert.equal(code, null, `${stage} contender exited normally`);
  assert.equal(signal, "SIGKILL", `${stage} contender was not killed at its crash point`);

  const recovered = contender({ TERMINA_AUTH_LOCK_PROVIDER: "google", TERMINA_AUTH_LOCK_KEY: "recovered" });
  assert.deepEqual(recovered, { ok: true });
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  if (stale) {
    assert.equal(auth.anthropic.key, "before", `${stage} recovery changed prior auth state`);
    assert.equal(auth.openai, undefined, `${stage} recovery wrote auth before its crash`);
  } else {
    assert.equal(auth.anthropic.key, "crashed", `${stage} cleanup lost the completed auth write`);
  }
  assert.equal(auth.google.key, "recovered");
  assert.equal(existsSync(lockPath), false, `${stage} left a stranded lock`);
  console.log(`PASS ${stage} resumes after SIGKILL (${stale ? "stale recovery" : "release"})`);
}

try {
resetAuth();
const liveWitness = writeDirectoryLock({ pid: process.pid, token: "live-owner-token", startedAt: 1 }, { holdWitness: true });
const liveResult = contender();
assert.deepEqual(liveResult, { ok: false, error: "auth file busy" });
assert.deepEqual(JSON.parse(readFileSync(ownerRecordPath(), "utf8")), {
  pid: process.pid,
  token: "live-owner-token",
  startedAt: 1,
  processIdentity: processIdentity(process.pid),
  dev: lstatSync(lockPath).dev,
  ino: lstatSync(lockPath).ino,
});
assert.equal(readFileSync(authPath, "utf8"), baseline);
console.log("PASS live owner is not stolen after four seconds");
closeSync(liveWitness);

resetAuth();
const deadOwner = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
assert.equal(deadOwner.status, 0);
writeDirectoryLock({ pid: Number(deadOwner.stdout), token: "dead-owner-token", startedAt: 1 });
const deadResult = contender();
assert.deepEqual(deadResult, { ok: true });
assert.equal(JSON.parse(readFileSync(authPath, "utf8")).anthropic.key, "after");
assert.equal(existsSync(lockPath), false);
console.log("PASS dead owner is recovered");

for (const [name, lock] of [["malformed", "not json"], ["oversized", "x".repeat(8_193)]]) {
  resetAuth();
  writeDirectoryLock(lock);
  const result = contender();
  assert.deepEqual(result, { ok: false, error: "auth file busy" }, name);
  assert.equal(readFileSync(ownerRecordPath(), "utf8"), lock, `${name} lock was changed`);
  assert.equal(readFileSync(authPath, "utf8"), baseline, `${name} lock allowed an auth write`);
  console.log(`PASS ${name} lock fails closed`);
}

resetAuth();
writeDirectoryLock({ pid: 41_041, token: "eperm-owner-token", startedAt: 1 });
const epermResult = contender({ TERMINA_AUTH_LOCK_EPERM: "1" });
assert.deepEqual(epermResult, { ok: false, error: "auth file busy" });
assert.deepEqual(JSON.parse(readFileSync(ownerRecordPath(), "utf8")), {
  pid: 41_041,
  token: "eperm-owner-token",
  startedAt: 1,
  processIdentity: processIdentity(41_041),
  dev: lstatSync(lockPath).dev,
  ino: lstatSync(lockPath).ino,
});
assert.equal(readFileSync(authPath, "utf8"), baseline);
console.log("PASS EPERM owner is treated as alive");

resetAuth();
writeDirectoryLock({ pid: 41_042, token: "unknown-owner-token", startedAt: 1, processIdentity: "unobservable-owner" });
const unknownResult = contender({ TERMINA_AUTH_LOCK_UNKNOWN: "1" });
assert.deepEqual(unknownResult, { ok: false, error: "auth file busy" });
assert.equal(readFileSync(authPath, "utf8"), baseline);
console.log("PASS unknown process identity fails closed");

resetAuth();
const reusedPidProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
const reusedPidHandle = trackChild(reusedPidProcess, "reused-pid holder");
try {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  writeDirectoryLock({
    pid: reusedPidProcess.pid,
    token: "reused-pid-owner-token",
    startedAt: 1,
    processIdentity: processIdentity(reusedPidProcess.pid),
  });
  const reusedPidResult = contender();
  assert.deepEqual(reusedPidResult, { ok: true });
  assert.equal(JSON.parse(readFileSync(authPath, "utf8")).anthropic.key, "after");
  assert.equal(existsSync(lockPath), false);
  console.log("PASS a same-second PID reuse without the holder witness is recovered");
} finally {
  await stopChild(reusedPidHandle);
}

resetAuth();
const replacementResult = contender({ TERMINA_AUTH_LOCK_MODE: "same-token-directory-replacement" });
assert.deepEqual(replacementResult, { ok: true });
assert.equal(existsSync(lockPath), true);
assert.equal(readdirSync(lockPath).some((name) => name.startsWith(".record-")), true);
assert.equal(readdirSync(lockPath).some((name) => name.startsWith(".owner-")), true);
console.log("PASS owner release preserves a copied valid-directory replacement");

resetAuth();
const staleOwner = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
assert.equal(staleOwner.status, 0);
writeDirectoryLock({ pid: Number(staleOwner.stdout), token: "concurrent-dead-owner", startedAt: 1 });
const start = join(root, "concurrent-start");
const entered = join(root, "concurrent-entered");
const release = join(root, "concurrent-release");
const concurrentInspected = join(root, "concurrent-inspected");
const concurrentResume = join(root, "concurrent-resume");
mkdirSync(entered);
const second = startContender({
  TERMINA_AUTH_LOCK_MODE: "pause-after-stale-inspection",
  TERMINA_AUTH_LOCK_INSPECTED: concurrentInspected,
  TERMINA_AUTH_LOCK_RESUME: concurrentResume,
  TERMINA_AUTH_LOCK_PROVIDER: "openai",
  TERMINA_AUTH_LOCK_KEY: "second",
});
waitFor(() => existsSync(concurrentInspected), "second contender did not inspect the stale lock");
const first = startContender({
  TERMINA_AUTH_LOCK_MODE: "concurrent", TERMINA_AUTH_LOCK_START: start, TERMINA_AUTH_LOCK_ENTERED: entered,
  TERMINA_AUTH_LOCK_RELEASE: release, TERMINA_AUTH_LOCK_PROVIDER: "anthropic", TERMINA_AUTH_LOCK_KEY: "first",
});
writeFileSync(start, "go");
waitFor(() => readdirSync(entered).length === 1, "no stale-lock recoverer acquired the lock");
writeFileSync(concurrentResume, "go");
const concurrentSecondResult = await second.result();
assert.deepEqual(concurrentSecondResult, { ok: false, error: "auth file busy" });
writeFileSync(release, "go");
const concurrentFirstResult = await first.result();
assert.deepEqual(concurrentFirstResult, { ok: true });
const concurrentAuth = JSON.parse(readFileSync(authPath, "utf8"));
assert.equal(Object.values(concurrentAuth).filter((entry) => entry?.key === "first").length, 1);
console.log("PASS simultaneous stale recovery admits exactly one writer");

resetAuth();
const delayedOwner = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
assert.equal(delayedOwner.status, 0);
writeDirectoryLock({ pid: Number(delayedOwner.stdout), token: "delayed-dead-owner", startedAt: 1 });
const inspected = join(root, "delayed-inspected");
const resume = join(root, "delayed-resume");
const replacementStart = join(root, "delayed-replacement-start");
const replacementEntered = join(root, "delayed-replacement-entered");
const replacementRelease = join(root, "delayed-replacement-release");
mkdirSync(replacementEntered);
const delayed = startContender({
  TERMINA_AUTH_LOCK_MODE: "pause-after-stale-inspection",
  TERMINA_AUTH_LOCK_INSPECTED: inspected,
  TERMINA_AUTH_LOCK_RESUME: resume,
});
waitFor(() => existsSync(inspected), "stale contender did not pause after inspecting generation S");
const replacement = startContender({
  TERMINA_AUTH_LOCK_MODE: "concurrent",
  TERMINA_AUTH_LOCK_START: replacementStart,
  TERMINA_AUTH_LOCK_ENTERED: replacementEntered,
  TERMINA_AUTH_LOCK_RELEASE: replacementRelease,
  TERMINA_AUTH_LOCK_PROVIDER: "openai",
  TERMINA_AUTH_LOCK_KEY: "replacement",
});
writeFileSync(replacementStart, "go");
waitFor(() => readdirSync(replacementEntered).length === 1, "replacement owner did not acquire generation N");
writeFileSync(resume, "go");
const delayedResult = await delayed.result();
assert.deepEqual(delayedResult, { ok: false, error: "auth file busy" });
writeFileSync(replacementRelease, "go");
const replacementResultAfterDelay = await replacement.result();
assert.deepEqual(replacementResultAfterDelay, { ok: true });
assert.equal(existsSync(lockPath), false, "delayed stale recovery must not strand the replacement lock");
assert.equal(JSON.parse(readFileSync(authPath, "utf8")).openai.key, "replacement");
console.log("PASS delayed stale recovery cannot damage replacement generation");

await crashRecoveryCase("release-before-guard-removal", false);
await crashRecoveryCase("release-after-guard-removal", false);
await crashRecoveryCase("recover-before-guard-removal", true);
await crashRecoveryCase("recover-after-guard-removal", true);

resetAuth();
const crashedEntered = join(root, "crashed-entered");
const crashed = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "-e", childCode()], {
  cwd: resolve("."),
  env: {
    ...process.env,
    TERMINA_CORE_TEST: "1",
    TERMINA_AUTH_PATH: authPath,
    TERMINA_AUTH_LOCK_MODE: "crash-after-entered",
    TERMINA_AUTH_LOCK_ENTERED: crashedEntered,
    TERMINA_AUTH_LOCK_PROVIDER: "anthropic",
    TERMINA_AUTH_LOCK_KEY: "crashed",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const crashedHandle = trackChild(crashed, "critical-section crash holder");
let crashedStderr = "";
crashed.stderr.on("data", (chunk) => { crashedStderr += chunk; });
waitFor(() => existsSync(crashedEntered), "crashed holder did not enter its critical section");
const [crashedCode, crashedSignal] = await waitChild(crashedHandle);
assert.equal(crashedCode, null, `crashed holder exited normally: ${crashedStderr}`);
assert.equal(crashedSignal, "SIGKILL");
const recoveredAfterCrash = contender({ TERMINA_AUTH_LOCK_PROVIDER: "openai", TERMINA_AUTH_LOCK_KEY: "recovered" });
assert.deepEqual(recoveredAfterCrash, { ok: true });
assert.equal(JSON.parse(readFileSync(authPath, "utf8")).openai.key, "recovered");
assert.equal(existsSync(lockPath), false, "crash recovery must release the recovered lock");
console.log("PASS a crashed holder is recovered by the next writer");
} finally {
  await stopActiveChildren();
  rmSync(root, { recursive: true, force: true });
}
