import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
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

describe("Agent Core Auth Lock & Crash Recovery", () => {
  let root: string;
  let authPath: string;
  let lockPath: string;
  let authModule: string;
  const baseline = '{\n  "anthropic": { "type": "api_key", "key": "before" }\n}\n';
  const activeChildren = new Set<{ child: ChildProcess; label: string; done: Promise<any> }>();

  function processIdentity(pid: number): string {
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
        // Dead fixture fallback
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

  function trackChild(child: ChildProcess, label: string) {
    const handle = { child, label, done: once(child, "close") };
    activeChildren.add(handle);
    return handle;
  }

  async function waitChild(handle: { child: ChildProcess; label: string; done: Promise<any> }) {
    let timeout: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        handle.done,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${handle.label} did not exit before deadline`)), 15_000);
        }),
      ]);
      activeChildren.delete(handle);
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function stopChild(handle: { child: ChildProcess; label: string; done: Promise<any> }) {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      try {
        handle.child.kill("SIGKILL");
      } catch (error: any) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    await waitChild(handle);
  }

  async function stopActiveChildren() {
    await Promise.allSettled([...activeChildren].map((handle) => stopChild(handle)));
  }

  function ownerRecordPath(): string {
    const entry = readdirSync(lockPath).find((name) => name.startsWith(".record-"));
    expect(entry).toBeTruthy();
    return join(lockPath, entry!);
  }

  function writeDirectoryLock(value: any, { holdWitness = false } = {}) {
    mkdirSync(lockPath, { mode: 0o700 });
    const directory = lstatSync(lockPath);
    if (typeof value === "string") {
      const token = "malformed-fixture";
      writeFileSync(join(lockPath, `.record-${token}-${directory.dev}-${directory.ino}`), value, { mode: 0o600 });
      mkdirSync(join(lockPath, `.owner-${token}-${directory.dev}-${directory.ino}`), { mode: 0o700 });
      return null;
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

  function childCode(): string {
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
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    return JSON.parse(child.stdout.trim());
  }

  function startContender(options = {}) {
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
        expect(code).toBe(0);
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

  function waitFor(checkFn: () => boolean, message: string) {
    const deadline = Date.now() + 5_000;
    while (!checkFn()) {
      if (Date.now() >= deadline) throw new Error(message);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  function resetAuth() {
    rmSync(lockPath, { recursive: true, force: true });
    writeFileSync(authPath, baseline, { mode: 0o600 });
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "termina-auth-lock-"));
    authPath = join(root, "auth.json");
    lockPath = `${authPath}.lock`;
    authModule = pathToFileURL(resolve("agent-core/auth.ts")).href;
  });

  afterAll(async () => {
    await stopActiveChildren();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetAuth();
  });

  it("does not steal lock from live owner holding witness handle", () => {
    const liveWitness = writeDirectoryLock({ pid: process.pid, token: "live-owner-token", startedAt: 1 }, { holdWitness: true });
    try {
      const liveResult = contender();
      expect(liveResult).toEqual({ ok: false, error: "auth file busy" });
      expect(JSON.parse(readFileSync(ownerRecordPath(), "utf8"))).toEqual({
        pid: process.pid,
        token: "live-owner-token",
        startedAt: 1,
        processIdentity: processIdentity(process.pid),
        dev: lstatSync(lockPath).dev,
        ino: lstatSync(lockPath).ino,
      });
      expect(readFileSync(authPath, "utf8")).toBe(baseline);
    } finally {
      if (liveWitness !== null) closeSync(liveWitness);
    }
  });

  it("recovers lock from dead owner", () => {
    const deadOwner = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    expect(deadOwner.status).toBe(0);
    writeDirectoryLock({ pid: Number(deadOwner.stdout), token: "dead-owner-token", startedAt: 1 });
    const deadResult = contender();
    expect(deadResult).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(authPath, "utf8")).anthropic.key).toBe("after");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fails closed on malformed and oversized locks", () => {
    for (const [name, lock] of [["malformed", "not json"], ["oversized", "x".repeat(8_193)]] as const) {
      resetAuth();
      writeDirectoryLock(lock);
      const result = contender();
      expect(result).toEqual({ ok: false, error: "auth file busy" });
      expect(readFileSync(ownerRecordPath(), "utf8")).toBe(lock);
      expect(readFileSync(authPath, "utf8")).toBe(baseline);
    }
  });

  it("treats EPERM owner as alive and unknown identity fails closed", () => {
    writeDirectoryLock({ pid: 41_041, token: "eperm-owner-token", startedAt: 1 });
    const epermResult = contender({ TERMINA_AUTH_LOCK_EPERM: "1" });
    expect(epermResult).toEqual({ ok: false, error: "auth file busy" });
    expect(readFileSync(authPath, "utf8")).toBe(baseline);

    resetAuth();
    writeDirectoryLock({ pid: 41_042, token: "unknown-owner-token", startedAt: 1, processIdentity: "unobservable-owner" });
    const unknownResult = contender({ TERMINA_AUTH_LOCK_UNKNOWN: "1" });
    expect(unknownResult).toEqual({ ok: false, error: "auth file busy" });
    expect(readFileSync(authPath, "utf8")).toBe(baseline);
  });

  it("admits exactly one writer during simultaneous stale recovery", async () => {
    const staleOwner = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
    expect(staleOwner.status).toBe(0);
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
    waitFor(() => existsSync(concurrentInspected), "second contender did not inspect stale lock");

    const first = startContender({
      TERMINA_AUTH_LOCK_MODE: "concurrent", TERMINA_AUTH_LOCK_START: start, TERMINA_AUTH_LOCK_ENTERED: entered,
      TERMINA_AUTH_LOCK_RELEASE: release, TERMINA_AUTH_LOCK_PROVIDER: "anthropic", TERMINA_AUTH_LOCK_KEY: "first",
    });
    writeFileSync(start, "go");
    waitFor(() => readdirSync(entered).length === 1, "no stale-lock recoverer acquired lock");

    writeFileSync(concurrentResume, "go");
    const concurrentSecondResult = await second.result();
    expect(concurrentSecondResult).toEqual({ ok: false, error: "auth file busy" });

    writeFileSync(release, "go");
    const concurrentFirstResult = await first.result();
    expect(concurrentFirstResult).toEqual({ ok: true });

    const concurrentAuth = JSON.parse(readFileSync(authPath, "utf8"));
    expect(Object.values(concurrentAuth).filter((entry: any) => entry?.key === "first").length).toBe(1);
  });

  it("recovers when a holder crashes in its critical section", async () => {
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
    waitFor(() => existsSync(crashedEntered), "crashed holder did not enter critical section");
    const [crashedCode, crashedSignal] = await waitChild(crashedHandle);
    expect(crashedCode).toBeNull();
    expect(crashedSignal).toBe("SIGKILL");

    const recoveredAfterCrash = contender({ TERMINA_AUTH_LOCK_PROVIDER: "openai", TERMINA_AUTH_LOCK_KEY: "recovered" });
    expect(recoveredAfterCrash).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(authPath, "utf8")).openai.key).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });
});
