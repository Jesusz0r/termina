import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";

const workspace = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), "termina-e2e-isolation-test-"));
const fakeElectron = join(workspace, "scripts", "e2e-isolation-fake-electron.mjs");
const runner = join(workspace, "scripts", "e2e.mjs");
const smokeSuite = "e2e-isolation-smoke-suite.mjs";
const blockingChild = join(workspace, "scripts", "e2e-isolation-blocking-child.mjs");
const coreBuildFixture = join(workspace, "scripts", "e2e-isolation-core-build.mjs");
const trackedPids = new Set();
const trackedRunners = new Set();
const hostHome = join(scratch, "host-home");
const hostAgent = join(hostHome, ".pi", "agent");
const hostSentinel = join(hostAgent, "termina-e2e-agent-touch");
await mkdir(hostAgent, { recursive: true });
await writeFile(hostSentinel, "untouched\n");

function waitForLine(child, predicate, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for child output; got ${buffered}`)), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      for (const line of buffered.split("\n")) {
        if (predicate(line)) {
          clearTimeout(timer);
          resolve(line);
          return;
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`child exited before ready (${code ?? signal}); output: ${buffered}`));
    });
  });
}

function waitForExit(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`runner timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitForJson(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(processIsAlive(pid), false, message);
}

async function waitForProcessGroupExit(pid, message, timeoutMs = 5_000) {
  if (process.platform === "win32") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.throws(() => process.kill(-pid, 0), { code: "ESRCH" }, message);
}

async function assertPathRemoved(path, message) {
  await assert.rejects(access(path), (error) => {
    assert.equal(error?.code, "ENOENT", message);
    return true;
  });
}

async function listModules(root) {
  const modules = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) modules.push(...await listModules(path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) modules.push(path);
  }
  return modules;
}

async function spawnRunner(instance, { args = ["--skip-build", smokeSuite], env = {}, timeoutMs = 20_000 } = {}) {
  const child = spawn(process.execPath, [runner, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_ENV: "test",
      TERMINA_E2E_TEST_ELECTRON: fakeElectron,
      TERMINA_E2E_TEST_RESULT_DIR: scratch,
      TERMINA_E2E_TEST_SIGNAL_DIR: scratch,
      TERMINA_E2E_TEST_BARRIER_DIR: scratch,
      TERMINA_E2E_TEST_INSTANCES: "one,two",
      TERMINA_E2E_TEST_INSTANCE: instance,
      TERMINA_E2E_TEST_READY_DELAY_MS: "0",
      TERMINA_E2E_TEST_PID_DIR: scratch,
      HOME: hostHome,
      USERPROFILE: hostHome,
      TERMINA_E2E_TEST_TOUCH_AGENT: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackedRunners.add(child);
  child.once("exit", () => { trackedRunners.delete(child); });
  return { child, result: waitForExit(child, timeoutMs) };
}

async function assertDirectoryEmpty(path, message) {
  assert.deepEqual(await readdir(path), [], message);
}

let foreign;
try {
  foreign = spawn(process.execPath, [fakeElectron, "--foreign-listener=0"], {
    cwd: workspace,
    env: { ...process.env, TERMINA_E2E_TEST_SIGNAL_FILE: join(scratch, "foreign-signals.log") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const foreignReady = await waitForLine(foreign, (line) => /^FOREIGN_READY \d+$/.test(line));
  const foreignPort = Number(foreignReady.split(" ")[1]);
  assert.ok(foreignPort > 0 && foreignPort <= 65_535);
  const foreignHealthUrl = `http://127.0.0.1:${foreignPort}/health`;
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const one = await spawnRunner("one");
  const two = await spawnRunner("two");
  const [oneExit, twoExit] = await Promise.all([one.result, two.result]);
  assert.equal(oneExit.code, 0, `first runner failed\n${oneExit.stdout}\n${oneExit.stderr}`);
  assert.equal(twoExit.code, 0, `second runner failed\n${twoExit.stdout}\n${twoExit.stderr}`);

  const oneResult = JSON.parse(await readFile(join(scratch, "one.json"), "utf8"));
  const twoResult = JSON.parse(await readFile(join(scratch, "two.json"), "utf8"));
  assert.notEqual(oneResult.port, twoResult.port, "concurrent runners must use distinct DevTools ports");
  assert.notEqual(oneResult.runRoot, twoResult.runRoot, "concurrent runners must use distinct fixture/profile roots");
  assert.equal(oneResult.instance, "one");
  assert.equal(twoResult.instance, "two");
  for (const result of [oneResult, twoResult]) {
    for (const [kind, path] of Object.entries(result.paths)) {
      assert.ok(path.startsWith(`${result.runRoot}${sep}`), `${kind} must be under its runner-owned root`);
    }
    await assertPathRemoved(result.runRoot, `${result.instance} run root must be removed after normal completion`);
  }
  for (const kind of Object.keys(oneResult.paths)) {
    assert.notEqual(oneResult.paths[kind], twoResult.paths[kind], `concurrent runners must use distinct ${kind} paths`);
  }

  assert.equal(foreign.exitCode, null, "the runner must not signal the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });
  await assert.rejects(readFile(join(scratch, "foreign-signals.log"), "utf8"), { code: "ENOENT" });

  for (const instance of ["one", "two"]) {
    const signals = await readFile(join(scratch, `${instance}-signals.log`), "utf8");
    assert.equal(signals, "SIGTERM\n", `${instance} runner must stop only its owned Electron process group`);
    const suite = JSON.parse(await readFile(join(scratch, `${instance}.json`), "utf8"));
    const electron = JSON.parse(await readFile(join(scratch, `${instance}-electron.json`), "utf8"));
    await waitForProcessExit(suite.pid, `${instance} normal cleanup must not orphan the suite`);
    await waitForProcessGroupExit(suite.pid, `${instance} normal cleanup must not orphan the suite's process group`);
    await waitForProcessExit(electron.pid, `${instance} normal cleanup must not orphan Electron`);
    await waitForProcessGroupExit(electron.pid, `${instance} normal cleanup must not orphan Electron's process group`);
  }
  assert.equal(await readFile(hostSentinel, "utf8"), "untouched\n", "E2E must not mutate the host HOME sentinel");

  const hungRequest = await spawnRunner("hung-request", {
    env: {
      TERMINA_E2E_TEST_HANG_FIRST_JSON: "1",
      TERMINA_E2E_TEST_INSTANCES: "hung-request",
    },
    timeoutMs: 5_000,
  });
  const hungRequestExit = await hungRequest.result;
  assert.equal(hungRequestExit.code, 0, `a stalled DevTools response must be aborted and retried\n${hungRequestExit.stdout}\n${hungRequestExit.stderr}`);
  const hungRequestResult = JSON.parse(await readFile(join(scratch, "hung-request.json"), "utf8"));
  await assertPathRemoved(hungRequestResult.runRoot, "readiness retry must still remove the owned run root");
  const hungRequestElectron = JSON.parse(await readFile(join(scratch, "hung-request-electron.json"), "utf8"));
  await waitForProcessExit(hungRequestResult.pid, "readiness retry must not orphan the suite");
  await waitForProcessGroupExit(hungRequestResult.pid, "readiness retry must not orphan the suite's process group");
  await waitForProcessExit(hungRequestElectron.pid, "readiness retry must not orphan Electron");
  await waitForProcessGroupExit(hungRequestElectron.pid, "readiness retry must not orphan Electron's process group");
  assert.equal(foreign.exitCode, null, "readiness retry must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const readinessDeadlineStart = Date.now();
  const readinessDeadline = await spawnRunner("readiness-deadline", {
    env: {
      TERMINA_E2E_TEST_HANG_JSON: "1",
      TERMINA_E2E_TEST_READY_TIMEOUT_MS: "250",
      TERMINA_E2E_TEST_INSTANCES: "readiness-deadline",
    },
    timeoutMs: 5_000,
  });
  const readinessDeadlineExit = await readinessDeadline.result;
  const readinessDeadlineElapsed = Date.now() - readinessDeadlineStart;
  assert.equal(readinessDeadlineExit.code, 1, `a hung DevTools response must fail at the readiness deadline\n${readinessDeadlineExit.stdout}\n${readinessDeadlineExit.stderr}`);
  assert.match(readinessDeadlineExit.stderr, /Electron did not publish a usable DevTools port/);
  assert.ok(readinessDeadlineElapsed < 4_500, `readiness deadline took ${readinessDeadlineElapsed}ms`);
  const readinessDeadlineResult = JSON.parse(await readFile(join(scratch, "readiness-deadline-electron.json"), "utf8"));
  await assertPathRemoved(readinessDeadlineResult.runRoot, "readiness deadline must remove its owned run root");
  await waitForProcessExit(readinessDeadlineResult.pid, "readiness deadline must not orphan Electron");
  await waitForProcessGroupExit(readinessDeadlineResult.pid, "readiness deadline must not orphan Electron's process group");
  assert.equal(foreign.exitCode, null, "readiness deadline must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const stubbornElectron = await spawnRunner("stubborn-electron", {
    env: {
      TERMINA_E2E_TEST_IGNORE_TERM: "1",
      TERMINA_E2E_TEST_INSTANCES: "stubborn-electron",
    },
  });
  const stubbornElectronRecord = await waitForJson(join(scratch, "stubborn-electron-electron.json"));
  trackedPids.add(stubbornElectronRecord.pid);
  const stubbornElectronExit = await stubbornElectron.result;
  assert.equal(stubbornElectronExit.code, 0, `runner must escalate an ignored Electron SIGTERM\n${stubbornElectronExit.stdout}\n${stubbornElectronExit.stderr}`);
  await waitForProcessExit(stubbornElectronRecord.pid, "SIGKILL escalation must close stubborn Electron before runner exit");
  await waitForProcessGroupExit(stubbornElectronRecord.pid, "SIGKILL escalation must close stubborn Electron's process group");
  const stubbornSuiteRecord = JSON.parse(await readFile(join(scratch, "stubborn-electron.json"), "utf8"));
  await waitForProcessExit(stubbornSuiteRecord.pid, "normal cleanup must not orphan the stubborn suite");
  await waitForProcessGroupExit(stubbornSuiteRecord.pid, "normal cleanup must not orphan the stubborn suite's process group");
  trackedPids.delete(stubbornElectronRecord.pid);
  assert.equal(await readFile(join(scratch, "stubborn-electron-signals.log"), "utf8"), "SIGTERM\n");
  await assertPathRemoved(stubbornElectronRecord.runRoot, "SIGKILL escalation must precede run-root removal");
  assert.equal(foreign.exitCode, null, "SIGKILL escalation must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const signaled = await spawnRunner("suite-signal", {
    env: {
      TERMINA_E2E_TEST_BLOCK: "1",
      TERMINA_E2E_TEST_INSTANCES: "suite-signal",
    },
  });
  const suiteRecord = await waitForJson(join(scratch, "suite-signal.json"));
  const electronRecord = await waitForJson(join(scratch, "suite-signal-electron.json"));
  trackedPids.add(suiteRecord.pid);
  trackedPids.add(electronRecord.pid);
  signaled.child.kill("SIGTERM");
  const signaledExit = await signaled.result;
  assert.equal(signaledExit.code, 143, `signaled runner must preserve the SIGTERM exit status\n${signaledExit.stdout}\n${signaledExit.stderr}`);
  await waitForProcessExit(suiteRecord.pid, "runner SIGTERM must not orphan the active suite");
  await waitForProcessGroupExit(suiteRecord.pid, "runner SIGTERM must not orphan the active suite's process group");
  await waitForProcessExit(electronRecord.pid, "runner SIGTERM must not orphan its Electron group leader");
  await waitForProcessGroupExit(electronRecord.pid, "runner SIGTERM must not orphan Electron's process group");
    trackedPids.delete(suiteRecord.pid);
    trackedPids.delete(electronRecord.pid);
    await assertPathRemoved(suiteRecord.runRoot, "runner SIGTERM must remove its owned run root after child exit");
    assert.equal(foreign.exitCode, null, "signal cleanup must not stop the foreign listener");
    assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

    const repeated = await spawnRunner("repeated-signal", {
      env: {
        TERMINA_E2E_TEST_BLOCK: "1",
        TERMINA_E2E_TEST_IGNORE_TERM: "1",
        TERMINA_E2E_TEST_INSTANCES: "repeated-signal",
      },
    });
    const repeatedSuite = await waitForJson(join(scratch, "repeated-signal.json"));
    const repeatedElectron = await waitForJson(join(scratch, "repeated-signal-electron.json"));
    trackedPids.add(repeatedSuite.pid);
    trackedPids.add(repeatedElectron.pid);
    repeated.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));
    repeated.child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));
    repeated.child.kill("SIGHUP");
    await new Promise((resolve) => setTimeout(resolve, 50));
    repeated.child.kill("SIGTERM");
    const repeatedExit = await repeated.result;
    assert.equal(repeatedExit.code, 143, `repeated/mixed signals must preserve the first SIGTERM status\n${repeatedExit.stdout}\n${repeatedExit.stderr}`);
    await waitForProcessExit(repeatedSuite.pid, "repeated signals must not orphan the suite");
    await waitForProcessGroupExit(repeatedSuite.pid, "repeated signals must not orphan the suite's process group");
    await waitForProcessExit(repeatedElectron.pid, "repeated signals must not orphan Electron");
    await waitForProcessGroupExit(repeatedElectron.pid, "repeated signals must not orphan Electron's process group");
    trackedPids.delete(repeatedSuite.pid);
    trackedPids.delete(repeatedElectron.pid);
    await assertPathRemoved(repeatedSuite.runRoot, "repeated signals must remove the owned run root");
    assert.equal(foreign.exitCode, null, "repeated signals must not stop the foreign listener");
    assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const stopFailure = await spawnRunner("stop-failure", {
    env: {
      TERMINA_E2E_TEST_BLOCK: "1",
      TERMINA_E2E_TEST_STOP_FAILURE: "Electron",
      TERMINA_E2E_TEST_INSTANCES: "stop-failure",
    },
  });
  const stopFailureSuite = await waitForJson(join(scratch, "stop-failure.json"));
  const stopFailureElectron = await waitForJson(join(scratch, "stop-failure-electron.json"));
  trackedPids.add(stopFailureSuite.pid);
  trackedPids.add(stopFailureElectron.pid);
  stopFailure.child.kill("SIGTERM");
  const stopFailureExit = await stopFailure.result;
  assert.equal(stopFailureExit.code, 143, `stop failure must preserve the SIGTERM exit status\n${stopFailureExit.stdout}\n${stopFailureExit.stderr}`);
  assert.match(stopFailureExit.stderr, /E2E SIGTERM cleanup failed:/);
  await waitForProcessExit(stopFailureSuite.pid, "stop failure cleanup must still stop the suite");
  await waitForProcessGroupExit(stopFailureSuite.pid, "stop failure cleanup must still stop the suite's process group");
  await waitForProcessExit(stopFailureElectron.pid, "stop failure cleanup must still stop Electron");
  await waitForProcessGroupExit(stopFailureElectron.pid, "stop failure cleanup must still stop Electron's process group");
  trackedPids.delete(stopFailureSuite.pid);
  trackedPids.delete(stopFailureElectron.pid);
  await assertPathRemoved(stopFailureSuite.runRoot, "stop failure cleanup must remove its owned run root");
  assert.equal(foreign.exitCode, null, "stop failure cleanup must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const suiteWatchdog = await spawnRunner("suite-watchdog", {
    env: {
      TERMINA_E2E_TEST_BLOCK: "1",
      TERMINA_E2E_TEST_SUITE_TIMEOUT_MS: "250",
      TERMINA_E2E_TEST_SUITE_GRANDCHILD: "1",
      TERMINA_E2E_TEST_SUITE_GRANDCHILD_IGNORE_TERM: "1",
      TERMINA_E2E_TEST_BLOCKING_CHILD: blockingChild,
      TERMINA_E2E_TEST_INSTANCES: "suite-watchdog",
    },
    timeoutMs: 5_000,
  });
  const watchdogSuite = await waitForJson(join(scratch, "suite-watchdog.json"));
  const watchdogElectron = await waitForJson(join(scratch, "suite-watchdog-electron.json"));
  const watchdogGrandchild = await waitForJson(join(scratch, "suite-watchdog-suite-grandchild.json"));
  trackedPids.add(watchdogSuite.pid);
  trackedPids.add(watchdogElectron.pid);
  trackedPids.add(watchdogGrandchild.pid);
  const suiteWatchdogExit = await suiteWatchdog.result;
  assert.equal(suiteWatchdogExit.code, 1, "suite watchdog must fail a hung suite");
  assert.match(suiteWatchdogExit.stderr, /suite e2e-isolation-smoke-suite\.mjs timed out/);
  await waitForProcessExit(watchdogSuite.pid, "suite watchdog must stop the active suite");
  await waitForProcessGroupExit(watchdogSuite.pid, "suite watchdog must stop the suite's process group");
  await waitForProcessExit(watchdogGrandchild.pid, "suite watchdog must stop the suite's child process");
  await waitForProcessGroupExit(watchdogGrandchild.groupId, "suite watchdog must stop the suite's process group after leader exit");
  await waitForProcessExit(watchdogElectron.pid, "suite watchdog must stop Electron");
  await waitForProcessGroupExit(watchdogElectron.pid, "suite watchdog must stop Electron's process group");
  trackedPids.delete(watchdogSuite.pid);
  trackedPids.delete(watchdogElectron.pid);
  trackedPids.delete(watchdogGrandchild.pid);
  await assertPathRemoved(watchdogSuite.runRoot, "suite watchdog must remove its owned run root");
  assert.equal(foreign.exitCode, null, "suite watchdog must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const earlyExit = await spawnRunner("suite-early-exit", {
    env: {
      TERMINA_E2E_TEST_SUITE_GRANDCHILD: "1",
      TERMINA_E2E_TEST_SUITE_GRANDCHILD_IGNORE_TERM: "1",
      TERMINA_E2E_TEST_SUITE_EARLY_EXIT: "1",
      TERMINA_E2E_TEST_BLOCKING_CHILD: blockingChild,
      TERMINA_E2E_TEST_INSTANCES: "suite-early-exit",
    },
  });
  const earlySuite = await waitForJson(join(scratch, "suite-early-exit.json"));
  const earlyElectron = await waitForJson(join(scratch, "suite-early-exit-electron.json"));
  const earlyGrandchild = await waitForJson(join(scratch, "suite-early-exit-suite-grandchild.json"));
  trackedPids.add(earlySuite.pid);
  trackedPids.add(earlyElectron.pid);
  trackedPids.add(earlyGrandchild.pid);
  const earlyExitResult = await earlyExit.result;
  assert.equal(earlyExitResult.code, 0, "early suite exit must preserve the suite status");
  await waitForProcessExit(earlySuite.pid, "early suite cleanup must observe the leader exit");
  await waitForProcessExit(earlyGrandchild.pid, "early suite cleanup must stop a resistant grandchild");
  await waitForProcessGroupExit(earlyGrandchild.groupId, "early suite cleanup must settle the owned process group");
  await waitForProcessExit(earlyElectron.pid, "early suite cleanup must stop Electron");
  await waitForProcessGroupExit(earlyElectron.pid, "early suite cleanup must stop Electron's process group");
  trackedPids.delete(earlySuite.pid);
  trackedPids.delete(earlyElectron.pid);
  trackedPids.delete(earlyGrandchild.pid);
  await assertPathRemoved(earlySuite.runRoot, "early suite cleanup must remove its owned run root");
  assert.equal(foreign.exitCode, null, "early suite cleanup must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const electronSignaled = await spawnRunner("electron-signal", {
    env: {
      TERMINA_E2E_TEST_ELECTRON_READY_DELAY_MS: "30000",
      TERMINA_E2E_TEST_INSTANCES: "electron-signal",
    },
  });
  const startingElectron = await waitForJson(join(scratch, "electron-signal-electron.json"));
  trackedPids.add(startingElectron.pid);
  electronSignaled.child.kill("SIGTERM");
  const electronSignalExit = await electronSignaled.result;
  assert.equal(electronSignalExit.code, 143, `pre-readiness SIGTERM must preserve the signal exit status\n${electronSignalExit.stdout}\n${electronSignalExit.stderr}`);
  await waitForProcessExit(startingElectron.pid, "runner SIGTERM must not orphan Electron while DevTools is starting");
  await waitForProcessGroupExit(startingElectron.pid, "runner SIGTERM must not orphan Electron's process group while DevTools is starting");
  trackedPids.delete(startingElectron.pid);
  await assertPathRemoved(startingElectron.runRoot, "pre-readiness SIGTERM must remove its owned run root");
  await assert.rejects(readFile(join(scratch, "electron-signal.json"), "utf8"), { code: "ENOENT" });
  assert.equal(await readFile(join(scratch, "electron-signal-signals.log"), "utf8"), "SIGTERM\n");
  assert.equal(foreign.exitCode, null, "pre-readiness cleanup must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  if (process.platform !== "win32") {
    const hungUp = await spawnRunner("suite-hangup", {
      env: {
        TERMINA_E2E_TEST_BLOCK: "1",
        TERMINA_E2E_TEST_INSTANCES: "suite-hangup",
      },
    });
    const hangupSuite = await waitForJson(join(scratch, "suite-hangup.json"));
    const hangupElectron = await waitForJson(join(scratch, "suite-hangup-electron.json"));
    trackedPids.add(hangupSuite.pid);
    trackedPids.add(hangupElectron.pid);
    hungUp.child.kill("SIGHUP");
    const hangupExit = await hungUp.result;
    assert.equal(hangupExit.code, 129, `SIGHUP must run owned cleanup before exit\n${hangupExit.stdout}\n${hangupExit.stderr}`);
    await waitForProcessExit(hangupSuite.pid, "runner SIGHUP must not orphan the active suite");
    await waitForProcessGroupExit(hangupSuite.pid, "runner SIGHUP must not orphan the active suite's process group");
    await waitForProcessExit(hangupElectron.pid, "runner SIGHUP must not orphan Electron");
    await waitForProcessGroupExit(hangupElectron.pid, "runner SIGHUP must not orphan Electron's process group");
    trackedPids.delete(hangupSuite.pid);
    trackedPids.delete(hangupElectron.pid);
    await assertPathRemoved(hangupSuite.runRoot, "runner SIGHUP must remove its owned run root");
    assert.equal(foreign.exitCode, null, "SIGHUP cleanup must not stop the foreign listener");
    assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

    const cargoProbe = spawnSync(process.env.CARGO || "cargo", ["--version"], { encoding: "utf8" });
    const cargoAvailable = !cargoProbe.error && cargoProbe.status === 0;
    if (cargoAvailable) {
      const coreBuildBin = join(scratch, "core-build-bin");
      const fakeNpm = join(coreBuildBin, "npm");
      const foreignCargoHome = join(hostHome, ".cargo");
      const foreignAuth = join(hostHome, ".pi", "agent", "auth.json");
      const foreignSession = join(hostHome, ".pi", "agent", "sessions", "foreign.jsonl");
      const coreBuildResult = join(scratch, "core-build-isolation.json");
      await mkdir(coreBuildBin, { recursive: true });
      await mkdir(foreignCargoHome, { recursive: true });
      await mkdir(join(hostHome, ".pi", "agent", "sessions"), { recursive: true });
      await writeFile(join(foreignCargoHome, "config.toml"), "[term]\nverbose = true\n");
      await writeFile(foreignAuth, '{"foreign":"credential"}\n');
      await writeFile(foreignSession, '{"foreign":"session"}\n');
      await writeFile(fakeNpm, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(coreBuildFixture)}\n`);
      await chmod(fakeNpm, 0o755);
      const coreBuild = await spawnRunner("core-build-isolation", {
        args: [smokeSuite],
        env: {
          PATH: `${coreBuildBin}${delimiter}${process.env.PATH ?? ""}`,
          CARGO_HOME: foreignCargoHome,
          RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.HOME ?? "", ".rustup"),
          TERMINA_AUTH_PATH: foreignAuth,
          PI_SESSION_FILE: foreignSession,
          OPENAI_API_KEY: "foreign-api-key",
          TERMINA_SKIP_CORE_BUILD: "0",
          TERMINA_E2E_TEST_CORE_BUILD_RESULT: coreBuildResult,
          TERMINA_E2E_TEST_INSTANCES: "core-build-isolation",
        },
        timeoutMs: 10_000,
      });
      const coreBuildObserved = await waitForJson(coreBuildResult);
      const coreBuildExit = await coreBuild.result;
      assert.equal(coreBuildExit.code, 0, `isolated core build fixture failed\n${coreBuildExit.stdout}\n${coreBuildExit.stderr}`);
      assert.equal(coreBuildObserved.cargoStatus, 0, `Cargo must work under isolated HOME: ${coreBuildObserved.cargoStderr}`);
      assert.ok(coreBuildObserved.cargoVersion.includes("cargo"), "core build fixture must invoke Cargo");
      assert.ok(coreBuildObserved.home.startsWith(`${coreBuildObserved.runRoot}${sep}`), "Cargo must observe the runner-owned HOME");
      assert.equal(coreBuildObserved.authPathPresent, false, "foreign auth path must not cross the E2E boundary");
      assert.equal(coreBuildObserved.sessionPathPresent, false, "foreign session path must not cross the E2E boundary");
      assert.equal(coreBuildObserved.apiKeyPresent, false, "foreign provider credentials must not cross the E2E boundary");
      assert.equal(coreBuildObserved.cargoHome, join(coreBuildObserved.runRoot, "termina-e2e-cargo-home"), "Cargo must use a runner-owned Cargo home");
      assert.equal(coreBuildObserved.cargoConfigPresent, false, "foreign Cargo config must remain hidden");
      await waitForProcessExit(coreBuildObserved.pid, "core build fixture must not orphan its build child");
      await waitForProcessGroupExit(coreBuildObserved.groupId, "core build fixture must not orphan its build process group");
      await assertPathRemoved(coreBuildObserved.runRoot, "core build fixture must remove its runner-owned root");
      assert.equal(await readFile(join(foreignCargoHome, "config.toml"), "utf8"), "[term]\nverbose = true\n");
      assert.equal(await readFile(foreignAuth, "utf8"), '{"foreign":"credential"}\n');
      assert.equal(await readFile(foreignSession, "utf8"), '{"foreign":"session"}\n');
    } else {
      console.log("SKIP core-build isolation fixture: Cargo is unavailable in the parent toolchain");
    }

    const missingCargo = await spawnRunner("missing-cargo", {
      args: [smokeSuite],
      env: {
        PATH: join(scratch, "missing-cargo-bin"),
        CARGO: join(scratch, "missing-cargo-bin", "cargo"),
        TERMINA_SKIP_CORE_BUILD: "0",
        TERMINA_E2E_TEST_INSTANCES: "missing-cargo",
      },
      timeoutMs: 5_000,
    });
    const missingCargoStart = Date.now();
    const missingCargoExit = await missingCargo.result;
    assert.ok(Date.now() - missingCargoStart < 4_500, "missing Cargo must fail within a bounded deadline");
    assert.equal(missingCargoExit.code, 1, `missing Cargo must fail cleanly\n${missingCargoExit.stdout}\n${missingCargoExit.stderr}`);
    assert.match(missingCargoExit.stderr, /Cargo executable.*not found/i);

    const interrupted = await spawnRunner("suite-interrupt", {
      env: {
        TERMINA_E2E_TEST_BLOCK: "1",
        TERMINA_E2E_TEST_INSTANCES: "suite-interrupt",
      },
    });
    const interruptSuite = await waitForJson(join(scratch, "suite-interrupt.json"));
    const interruptElectron = await waitForJson(join(scratch, "suite-interrupt-electron.json"));
    trackedPids.add(interruptSuite.pid);
    trackedPids.add(interruptElectron.pid);
    interrupted.child.kill("SIGINT");
    const interruptExit = await interrupted.result;
    assert.equal(interruptExit.code, 130, "SIGINT must run owned cleanup before exit");
    await waitForProcessExit(interruptSuite.pid, "runner SIGINT must not orphan the active suite");
    await waitForProcessGroupExit(interruptSuite.pid, "runner SIGINT must not orphan the active suite's process group");
    await waitForProcessExit(interruptElectron.pid, "runner SIGINT must not orphan Electron");
    await waitForProcessGroupExit(interruptElectron.pid, "runner SIGINT must not orphan Electron's process group");
    trackedPids.delete(interruptSuite.pid);
    trackedPids.delete(interruptElectron.pid);
    await assertPathRemoved(interruptSuite.runRoot, "runner SIGINT must remove its owned run root");
    assert.equal(foreign.exitCode, null, "SIGINT cleanup must not stop the foreign listener");
    assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

    const fakeGitBin = join(scratch, "git-signal-bin");
    const fakeGit = join(fakeGitBin, "git");
    await mkdir(fakeGitBin, { recursive: true });
    await writeFile(fakeGit, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(blockingChild)}\n`);
    await chmod(fakeGit, 0o755);
    const gitSignaled = await spawnRunner("git-signal", {
      args: ["--skip-build", "worldline-run-boundary-test.mjs"],
      env: {
        PATH: `${fakeGitBin}${delimiter}${process.env.PATH ?? ""}`,
        TERMINA_E2E_TEST_CHILD_ROLE: "git",
        TERMINA_E2E_TEST_INSTANCES: "git-signal",
      },
    });
    const gitRecord = await waitForJson(join(scratch, "git-signal-git.json"));
    trackedPids.add(gitRecord.pid);
    gitSignaled.child.kill("SIGTERM");
    const gitExit = await gitSignaled.result;
    assert.equal(gitExit.code, 143, `fixture Git cleanup must preserve the SIGTERM exit status\n${gitExit.stdout}\n${gitExit.stderr}`);
    await waitForProcessExit(gitRecord.pid, "runner SIGTERM must not orphan fixture Git");
    await waitForProcessGroupExit(gitRecord.groupId, "runner SIGTERM must not orphan fixture Git's process group");
    trackedPids.delete(gitRecord.pid);
    await assertPathRemoved(gitRecord.runRoot, "fixture Git SIGTERM must remove its owned run root");
    assert.equal(foreign.exitCode, null, "fixture Git cleanup must not stop the foreign listener");
    assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

    const fakeGitHelperBin = join(scratch, "git-helper-bin");
    const fakeGitHelper = join(fakeGitHelperBin, "git");
    await mkdir(fakeGitHelperBin, { recursive: true });
    await writeFile(fakeGitHelper, `#!/bin/sh\nTERMINA_E2E_TEST_CHILD_ROLE=git-helper TERMINA_E2E_TEST_IGNORE_TERM=1 TERMINA_E2E_GROUP_ID=$$ ${JSON.stringify(process.execPath)} ${JSON.stringify(blockingChild)} &\nexit 0\n`);
    await chmod(fakeGitHelper, 0o755);
    const gitHelperTmp = join(scratch, "git-helper-tmp");
    await mkdir(gitHelperTmp, { recursive: true });
    const gitHelperSignaled = await spawnRunner("git-helper-signal", {
      args: ["--skip-build", "worldline-run-boundary-test.mjs"],
      env: {
        PATH: `${fakeGitHelperBin}${delimiter}${process.env.PATH ?? ""}`,
        TERMINA_E2E_TEST_INSTANCES: "git-helper-signal",
        TMPDIR: gitHelperTmp,
      },
      timeoutMs: 5_000,
    });
    const gitHelperRecord = await waitForJson(join(scratch, "git-helper-signal-git-helper.json"));
    trackedPids.add(gitHelperRecord.pid);
    gitHelperSignaled.child.kill("SIGTERM");
    const gitHelperExit = await gitHelperSignaled.result;
    assert.equal(gitHelperExit.code, 143, "fixture Git helper cleanup must preserve the SIGTERM exit status");
    await waitForProcessExit(gitHelperRecord.pid, "runner SIGTERM must stop a resistant fixture Git helper");
    await waitForProcessGroupExit(gitHelperRecord.groupId, "runner SIGTERM must settle the fixture Git process group");
    trackedPids.delete(gitHelperRecord.pid);
    await assertPathRemoved(gitHelperRecord.runRoot, "fixture Git helper cleanup must remove its owned run root");
    await assertDirectoryEmpty(gitHelperTmp, "fixture Git helper cleanup must remove its runner-owned root");
    assert.equal(foreign.exitCode, null, "fixture Git helper cleanup must not stop the foreign listener");
    assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

    if (cargoAvailable) {
      const fakeBin = join(scratch, "build-signal-bin");
      const fakeNpm = join(fakeBin, "npm");
      await mkdir(fakeBin, { recursive: true });
      await writeFile(fakeNpm, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(blockingChild)}\n`);
      await chmod(fakeNpm, 0o755);
      const buildSignaled = await spawnRunner("build-signal", {
        args: [smokeSuite],
        env: {
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          TERMINA_E2E_TEST_CHILD_ROLE: "build",
          TERMINA_E2E_TEST_SPAWN_GRANDCHILD: "1",
        },
      });
      const buildRecord = await waitForJson(join(scratch, "build-signal-build.json"));
      trackedPids.add(buildRecord.pid);
      const buildGrandchild = await waitForJson(join(scratch, "build-signal-build-grandchild.json"));
      trackedPids.add(buildGrandchild.pid);
      buildSignaled.child.kill("SIGTERM");
      const buildExit = await buildSignaled.result;
      assert.equal(buildExit.code, 143, `signaled build runner must preserve the SIGTERM exit status\n${buildExit.stdout}\n${buildExit.stderr}`);
      await waitForProcessExit(buildRecord.pid, "runner SIGTERM must not orphan the active build child");
      await waitForProcessExit(buildGrandchild.pid, "runner SIGTERM must stop the build's owned process group");
      await waitForProcessGroupExit(buildRecord.pid, "runner SIGTERM must stop the build's owned process group");
      await assertPathRemoved(buildRecord.runRoot, "build SIGTERM must remove its owned run root");
      trackedPids.delete(buildRecord.pid);
      trackedPids.delete(buildGrandchild.pid);
      assert.equal(foreign.exitCode, null, "build cleanup must not stop the foreign listener");
      assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });
    }
  }

  const missingBuildBin = join(scratch, "missing-build-bin");
  const buildFailureTmp = join(scratch, "build-spawn-failure-tmp");
  await mkdir(missingBuildBin, { recursive: true });
  await mkdir(buildFailureTmp, { recursive: true });
  const buildFailureCargo = join(missingBuildBin, "cargo");
  await writeFile(buildFailureCargo, "#!/bin/sh\nexit 0\n");
  await chmod(buildFailureCargo, 0o755);
  const buildFailure = await spawnRunner("build-spawn-failure", {
    args: [smokeSuite],
    env: { PATH: missingBuildBin, CARGO: buildFailureCargo, TMPDIR: buildFailureTmp, TERMINA_SKIP_CORE_BUILD: "1" },
  });
  const buildFailureExit = await buildFailure.result;
  assert.equal(buildFailureExit.code, 1, `build spawn failure must fail cleanly\n${buildFailureExit.stdout}\n${buildFailureExit.stderr}`);
  assert.match(buildFailureExit.stderr, /build failed to spawn:/);
  await assertDirectoryEmpty(buildFailureTmp, "build spawn failure must remove its runner-owned root");
  assert.equal(foreign.exitCode, null, "build spawn failure must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const gitFailureTmp = join(scratch, "git-spawn-failure-tmp");
  await mkdir(gitFailureTmp, { recursive: true });
  const gitSpawnFailure = await spawnRunner("git-spawn-failure", {
    args: ["--skip-build", "worldline-run-boundary-test.mjs"],
    env: {
      PATH: join(scratch, "missing-git-bin"),
      TERMINA_E2E_TEST_INSTANCES: "git-spawn-failure",
      TMPDIR: gitFailureTmp,
    },
    timeoutMs: 5_000,
  });
  const gitSpawnExit = await gitSpawnFailure.result;
  assert.equal(gitSpawnExit.code, 1, `fixture Git spawn failure must fail cleanly\n${gitSpawnExit.stdout}\n${gitSpawnExit.stderr}`);
  assert.match(gitSpawnExit.stderr, /git init -q failed:.*spawn git ENOENT/);
  await assertDirectoryEmpty(gitFailureTmp, "fixture Git spawn failure must remove its runner-owned root");
  assert.equal(foreign.exitCode, null, "fixture Git spawn failure must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const electronFailureTmp = join(scratch, "electron-startup-failure-tmp");
  await mkdir(electronFailureTmp, { recursive: true });
  const electronFailure = await spawnRunner("electron-startup-failure", {
    env: {
      TERMINA_E2E_TEST_ELECTRON: join(scratch, "missing-electron-executable"),
      TERMINA_E2E_TEST_INSTANCES: "electron-startup-failure",
      TMPDIR: electronFailureTmp,
    },
    timeoutMs: 5_000,
  });
  const electronFailureExit = await electronFailure.result;
  assert.equal(electronFailureExit.code, 1, `Electron startup failure must fail cleanly\n${electronFailureExit.stdout}\n${electronFailureExit.stderr}`);
  assert.match(electronFailureExit.stderr, /Electron exited with code 1 before opening DevTools/);
  await assertDirectoryEmpty(electronFailureTmp, "Electron startup failure must remove its runner-owned root");
  assert.equal(foreign.exitCode, null, "Electron startup failure must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const electronSpawnTmp = join(scratch, "electron-spawn-failure-tmp");
  await mkdir(electronSpawnTmp, { recursive: true });
  const electronSpawnFailure = await spawnRunner("electron-spawn-failure", {
    env: {
      TERMINA_E2E_TEST_FAIL_SPAWN: "electron",
      TERMINA_E2E_TEST_INSTANCES: "electron-spawn-failure",
      TMPDIR: electronSpawnTmp,
    },
    timeoutMs: 5_000,
  });
  const electronSpawnExit = await electronSpawnFailure.result;
  assert.equal(electronSpawnExit.code, 1, `Electron spawn error must fail cleanly\n${electronSpawnExit.stdout}\n${electronSpawnExit.stderr}`);
  assert.match(electronSpawnExit.stderr, /Electron failed to spawn:/);
  await assertDirectoryEmpty(electronSpawnTmp, "Electron spawn error must remove its runner-owned root");
  assert.equal(foreign.exitCode, null, "Electron spawn error must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const suiteSpawnTmp = join(scratch, "suite-spawn-failure-tmp");
  await mkdir(suiteSpawnTmp, { recursive: true });
  const suiteSpawnFailure = await spawnRunner("suite-spawn-failure", {
    env: {
      TERMINA_E2E_TEST_FAIL_SPAWN: "suite",
      TERMINA_E2E_TEST_INSTANCES: "suite-spawn-failure",
      TMPDIR: suiteSpawnTmp,
    },
    timeoutMs: 5_000,
  });
  const suiteSpawnElectron = await waitForJson(join(scratch, "suite-spawn-failure-electron.json"));
  trackedPids.add(suiteSpawnElectron.pid);
  const suiteSpawnExit = await suiteSpawnFailure.result;
  assert.equal(suiteSpawnExit.code, 1, `suite spawn error must fail cleanly\n${suiteSpawnExit.stdout}\n${suiteSpawnExit.stderr}`);
  assert.match(suiteSpawnExit.stderr, /suite e2e-isolation-smoke-suite\.mjs failed to spawn:/);
  await waitForProcessExit(suiteSpawnElectron.pid, "suite spawn error must not orphan its Electron process");
  await waitForProcessGroupExit(suiteSpawnElectron.pid, "suite spawn error must not orphan its Electron process group");
  trackedPids.delete(suiteSpawnElectron.pid);
  assert.equal(await readFile(join(scratch, "suite-spawn-failure-signals.log"), "utf8"), "SIGTERM\n");
  await assertDirectoryEmpty(suiteSpawnTmp, "suite spawn error must remove its runner-owned root");
  assert.equal(foreign.exitCode, null, "suite spawn error must not stop the foreign listener");
  assert.deepEqual(await get(foreignHealthUrl), { status: 200, body: "foreign" });

  const ungatedSeam = spawn(process.execPath, [runner, "--skip-build", smokeSuite], {
    cwd: workspace,
    env: { ...process.env, NODE_ENV: "production", TERMINA_E2E_TEST_FAIL_SPAWN: "suite" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ungatedSeamExit = await waitForExit(ungatedSeam, 5_000);
  assert.equal(ungatedSeamExit.code, 1, "the forced spawn-error seam must fail closed outside test mode");
  assert.match(ungatedSeamExit.stderr, /TERMINA_E2E_TEST_FAIL_SPAWN is only allowed with NODE_ENV=test/);

  for (const value of [undefined, "", "0", "65536", "12345junk", " 12345"] ) {
    const env = { ...process.env };
    if (value === undefined) delete env.TERMINA_E2E_PORT;
    else env.TERMINA_E2E_PORT = value;
    const child = spawn(process.execPath, [join(workspace, "scripts", smokeSuite)], {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await waitForExit(child, 5_000);
    assert.notEqual(result.code, 0, `invalid port ${JSON.stringify(value)} must fail`);
    assert.match(result.stderr, /TERMINA_E2E_PORT must be an integer from 1 to 65535/);
  }

  const runnerSource = await readFile(runner, "utf8");
  assert.doesNotMatch(runnerSource, /clearDebugPort|\blsof\b|\bpkill\b|-tiTCP/);
  assert.match(runnerSource, /--remote-debugging-port=0/);
  for (const name of ["AGENTS.md", "CONTRIBUTING.md"]) {
    const source = await readFile(join(workspace, name), "utf8");
    assert.doesNotMatch(source, /\bpkill\b|\blsof\b/, `${name} must not prescribe fixed-port or global-process cleanup`);
    assert.match(source, /DevToolsActivePort/, `${name} must describe profile-owned DevTools discovery`);
  }
  for (const path of await listModules(join(workspace, "scripts"))) {
    if ([fakeElectron, join(workspace, "scripts", "e2e-isolation-test.mjs")].includes(path)) continue;
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /https?:\/\/(?:127\.0\.0\.1|localhost):[0-9]+\/json/, `${path} has a fixed CDP URL`);
    assert.doesNotMatch(source, /--remote-debugging-port=[1-9][0-9]*/, `${path} has a fixed DevTools launch port`);
    if (source.includes("webSocketDebuggerUrl")) {
      assert.match(source, /e2ePort/, `${path} must validate TERMINA_E2E_PORT through the shared helper`);
    }
  }
  console.log("PASS e2e runner uses owned instance-scoped ports, roots, and cleanup");
} finally {
  for (const child of [...trackedRunners]) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
  }
  for (const pid of trackedPids) {
    if (processIsAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    }
  }
  if (foreign?.exitCode === null) {
    foreign.kill("SIGTERM");
    await new Promise((resolve) => foreign.once("exit", resolve));
  }
  await rm(scratch, { recursive: true, force: true });
}
