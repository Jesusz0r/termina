// @ts-nocheck
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const workspace = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), "termina-sandbox-gate-test-"));
const fakeChild = resolve("scripts/sandbox-security-gate-test-child.ts");
const wrappers = [
  { name: "live", path: resolve("scripts/sandbox-security-live-gate.ts") },
  { name: "policy", path: resolve("scripts/sandbox-security-policy-test.ts") },
];
const innerSandbox = resolve("scripts/sandbox-security-test.ts");
const signals = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
];
const activeRuns = new Set();
const activeDescendants = new Set();

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupIsAlive(pid) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolveExit, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => reject(new Error(`wrapper timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`)), timeoutMs);
    const finish = (result) => {
      clearTimeout(timer);
      resolveExit({ ...result, stdout, stderr });
    };
    child.once("error", (error) => finish({ error }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

async function waitForFile(path, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

async function waitForGone(pid, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.equal(processIsAlive(pid), false, `${label} must not be orphaned`);
}

async function waitForGroupGone(pid, label, timeoutMs = 5_000) {
  if (process.platform === "win32") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupIsAlive(pid)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  assert.equal(processGroupIsAlive(pid), false, `${label} process group must not be orphaned`);
}

function spawnWrapper(wrapper, mode, tag) {
  const marker = join(scratch, `${tag}.json`);
  const child = spawn(process.execPath, ["--experimental-strip-types", wrapper.path], {
    cwd: workspace,
    env: {
      ...process.env,
      NODE_ENV: "test",
      TERMINA_SANDBOX_GATE_TEST_CHILD: fakeChild,
      TERMINA_SANDBOX_GATE_TEST_MARKER: marker,
      TERMINA_SANDBOX_GATE_TEST_MODE: mode,
      TERMINA_SANDBOX_GATE_TIMEOUT_MS: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = { child, marker, result: waitForExit(child) };
  activeRuns.add(run);
  return run;
}

function spawnRealWrapper(wrapper, tag) {
  const marker = join(scratch, `${tag}.json`);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    TERMINA_SANDBOX_REQUIRE_LIVE: "1",
    TERMINA_SANDBOX_RACER_MARKER: marker,
    TERMINA_SANDBOX_TEST_HOLD_AFTER_RACER: "1",
    TERMINA_SANDBOX_GATE_TIMEOUT_MS: "15000",
  };
  delete env.TERMINA_SANDBOX_GATE_TEST_CHILD;
  delete env.TERMINA_SANDBOX_GATE_TEST_MODE;
  const child = spawn(process.execPath, ["--experimental-strip-types", wrapper.path], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run = { child, marker, result: waitForExit(child) };
  activeRuns.add(run);
  return run;
}

function spawnInner(mode, tag) {
  const marker = join(scratch, `${tag}.json`);
  const env = {
    ...process.env,
    NODE_ENV: "test",
    TERMINA_SANDBOX_REQUIRE_LIVE: "1",
    TERMINA_SANDBOX_RACER_MARKER: marker,
    ...(mode === "hold" ? { TERMINA_SANDBOX_TEST_HOLD_AFTER_RACER: "1" } : {}),
    ...(mode === "fail" ? { TERMINA_SANDBOX_TEST_FAIL_AFTER_RACER: "1" } : {}),
  };
  delete env.TERMINA_SANDBOX_GATE_WRAPPED;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", innerSandbox], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const run = { child, marker, grouped: process.platform !== "win32", result: waitForExit(child) };
  activeRuns.add(run);
  return run;
}

async function stopRun(run) {
  if (process.platform !== "win32") {
    for (const pid of [run.record?.child, run.record?.descendant]) {
      if (!pid) continue;
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
      }
    }
  }
  if (run.child.exitCode === null && run.child.signalCode === null && run.child.pid) {
    try {
      if (run.grouped) process.kill(-run.child.pid, "SIGKILL");
      else run.child.kill("SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
    }
  }
  await run.result.catch(() => undefined);
  activeRuns.delete(run);
}

async function assertDescendantsGone(record, label) {
  await waitForGone(record.child, `${label} child`);
  await waitForGone(record.descendant, `${label} descendant`);
  await waitForGroupGone(record.child, label);
}

async function assertInnerRacerGone(record, label) {
  await waitForGone(record.child, `${label} sandbox test`);
  await waitForGroupGone(record.child, `${label} sandbox test`);
  await waitForGone(record.descendant, `${label} racer`);
  await waitForGroupGone(record.descendant, `${label} racer`);
}

async function assertWrappedRacerGone(record, label) {
  await assertDescendantsGone(record, label);
  await waitForGroupGone(record.descendant, `${label} racer`);
}

try {
  if (process.platform === "win32") {
    console.log("SKIP sandbox gate signal/orphan lifecycle checks on Windows");
  } else {
    for (const wrapper of wrappers) {
      for (const [signal, code] of signals) {
        const run = spawnWrapper(wrapper, "hold", `${wrapper.name}-${signal}`);
        const record = await waitForFile(run.marker);
        run.record = record;
        run.child.kill(signal);
        const result = await run.result;
        assert.equal(result.code, code, `${wrapper.name} ${signal} must preserve signal exit semantics\n${result.stderr}`);
        await assertDescendantsGone(record, `${wrapper.name} ${signal}`);
        activeRuns.delete(run);
      }
    }

    for (const wrapper of wrappers) {
      const run = spawnWrapper(wrapper, "fail", `${wrapper.name}-failed-probe`);
      const record = await waitForFile(run.marker);
      run.record = record;
      const result = await run.result;
      if (wrapper.name === "live") assert.equal(result.code, 7, "live wrapper must preserve a failed probe exit code");
      else assert.equal(result.code, 0, "policy wrapper must classify the controlled failed probe explicitly");
      assert.match(`${result.stdout}\n${result.stderr}`, /live sandbox probes failed/);
      await assertDescendantsGone(record, `${wrapper.name} failed probe`);
      activeRuns.delete(run);
    }

    // Stop the inner process so only the wrapper can perform TERM-to-KILL
    // cleanup. A separately detached racer group must not survive escalation.
    const stoppedWrapper = wrappers[0];
    const stoppedRun = spawnRealWrapper(stoppedWrapper, "stopped-inner-term-kill");
    const stoppedRecord = await waitForFile(stoppedRun.marker);
    stoppedRun.record = stoppedRecord;
    activeDescendants.add(stoppedRecord.descendant);
    process.kill(stoppedRecord.child, "SIGSTOP");
    stoppedRun.child.kill("SIGTERM");
    const stoppedResult = await stoppedRun.result;
    assert.equal(stoppedResult.code, 143, "wrapper TERM must preserve signal exit semantics when inner is stopped");
    await assertWrappedRacerGone(stoppedRecord, "stopped inner TERM-to-KILL");
    activeDescendants.delete(stoppedRecord.descendant);
    activeRuns.delete(stoppedRun);

    if (process.platform === "darwin") {
      for (const [signal, code] of signals) {
        const run = spawnInner("hold", `inner-${signal}`);
        const record = await waitForFile(run.marker);
        run.record = record;
        activeDescendants.add(record.descendant);
        run.child.kill(signal);
        const result = await run.result;
        assert.equal(result.code, code, `inner sandbox ${signal} must preserve signal exit semantics\n${result.stderr}`);
        await assertInnerRacerGone(record, `inner ${signal}`);
        activeDescendants.delete(record.descendant);
        activeRuns.delete(run);
      }

      const failedInner = spawnInner("fail", "inner-failed-probe");
      const failedRecord = await waitForFile(failedInner.marker);
      failedInner.record = failedRecord;
      activeDescendants.add(failedRecord.descendant);
      const failedResult = await failedInner.result;
      assert.notEqual(failedResult.code, 0, "inner failed probe must fail closed");
      assert.match(`${failedResult.stdout}\n${failedResult.stderr}`, /injected sandbox racer probe failure/);
      await assertInnerRacerGone(failedRecord, "inner failed probe");
      activeDescendants.delete(failedRecord.descendant);
      activeRuns.delete(failedInner);
    }
  }
  console.log("sandbox gate signal/orphan and failed-probe contracts passed");
} finally {
  await Promise.all([...activeRuns].map((run) => stopRun(run)));
  for (const pid of activeDescendants) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await rm(scratch, { recursive: true, force: true });
}
