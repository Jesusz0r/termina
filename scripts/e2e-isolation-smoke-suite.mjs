import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { e2ePort } from "./e2e-port.mjs";

const port = e2ePort();
const response = await fetch(`http://127.0.0.1:${port}/json`);
if (!response.ok) throw new Error(`fake DevTools returned HTTP ${response.status}`);

const resultDir = process.env.TERMINA_E2E_TEST_RESULT_DIR;
const barrierDir = process.env.TERMINA_E2E_TEST_BARRIER_DIR;
const pidDir = process.env.TERMINA_E2E_TEST_PID_DIR;
const instance = process.env.TERMINA_E2E_TEST_INSTANCE;
const runRoot = process.env.TERMINA_E2E_RUN_ROOT;
if (!resultDir || !barrierDir || !pidDir || !instance || !runRoot) throw new Error("missing E2E isolation smoke-test environment");

const home = homedir();
const agent = join(home, ".pi", "agent");
const agentTouch = join(agent, "termina-e2e-agent-touch");
if (process.env.TERMINA_E2E_TEST_TOUCH_AGENT === "1") {
  await mkdir(agent, { recursive: true });
  await writeFile(agentTouch, "runner-owned\n");
}

const paths = {
  fixture: process.env.TERMINA_INITIAL_CWD,
  events: process.env.TERMINA_EVENTS_DIR,
  worlds: process.env.TERMINA_WORLDS_DIR,
  userData: process.env.TERMINA_USER_DATA_DIR,
  home,
  agent,
  ...(process.env.TERMINA_E2E_TEST_TOUCH_AGENT === "1" ? { agentTouch } : {}),
};
await writeFile(join(resultDir, `${instance}.json`), `${JSON.stringify({ instance, pid: process.pid, port, runRoot, paths })}\n`);
await writeFile(join(barrierDir, `${instance}.ready`), "ready\n");

const peers = (process.env.TERMINA_E2E_TEST_INSTANCES ?? "").split(",").filter(Boolean);
const deadline = Date.now() + 5_000;
let synchronized = false;
while (Date.now() < deadline) {
  const statuses = await Promise.all(peers.map(async (peer) => {
    try {
      await access(join(barrierDir, `${peer}.ready`));
      return true;
    } catch {
      return false;
    }
  }));
  if (statuses.every(Boolean)) {
    synchronized = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}
if (!synchronized) throw new Error("concurrent E2E runner barrier timed out");

if (process.env.TERMINA_E2E_TEST_SUITE_GRANDCHILD === "1") {
  const blockingChild = process.env.TERMINA_E2E_TEST_BLOCKING_CHILD;
  if (!blockingChild) throw new Error("missing blocking child path for suite-grandchild test");
  spawn(process.execPath, [blockingChild], {
    env: {
      ...process.env,
      TERMINA_E2E_TEST_CHILD_ROLE: "suite-grandchild",
      TERMINA_E2E_GROUP_ID: String(process.pid),
      ...(process.env.TERMINA_E2E_TEST_SUITE_GRANDCHILD_IGNORE_TERM === "1" ? { TERMINA_E2E_TEST_IGNORE_TERM: "1" } : {}),
    },
    stdio: "inherit",
  });
  const grandchildRecord = join(pidDir, `${instance}-suite-grandchild.json`);
  const grandchildDeadline = Date.now() + 5_000;
  while (Date.now() < grandchildDeadline) {
    try {
      await access(grandchildRecord);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await access(grandchildRecord);
  if (process.env.TERMINA_E2E_TEST_SUITE_EARLY_EXIT === "1") process.exit(0);
}

if (process.env.TERMINA_E2E_TEST_BLOCK === "1") {
  const signalDir = process.env.TERMINA_E2E_TEST_SIGNAL_DIR;
  const stop = async (signal) => {
    if (signalDir) {
      await mkdir(signalDir, { recursive: true });
      await appendFile(join(signalDir, `${instance}-suite-signals.log`), `${signal}\n`);
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => { void stop("SIGTERM"); });
  process.once("SIGINT", () => { void stop("SIGINT"); });
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
