/**
 * Verify & Iterate cancellation e2e test.
 *
 * Launch requirement:
 *   PI_EDITOR_EVENTS_DIR=/tmp/pi-editor-events-test
 *   PI_EDITOR_INITIAL_CWD=<project with a SLOW test script:
 *     package.json: { "scripts": { "test": "node -e 'setTimeout(()=>{},30000)'" } }>
 *   --remote-debugging-port=9222
 *
 * Steps:
 *   1. runVerify spawns a worker; the worker pane auto-activates (instances
 *      arrive before the running push).
 *   2. Ctrl+C into the worker interrupts the run.
 *   3. The state becomes "cancelled"; the badge shows it; no context file is
 *      written (a cancelled run is not a test result).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const eventsDir = "/tmp/pi-editor-events-test";
const ctxFile = join(eventsDir, "verify-term-1.md");

const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };

// ---- 1. run verify; the worker pane auto-activates ----
const run = await evalJs(`window.pi.runVerify('term-1')`);
check("runVerify starts ok", run?.ok === true, JSON.stringify(run));
let workerId = null;
let activated = false;
for (let i = 0; i < 30; i++) {
  await sleep(300);
  const insts = await evalJs(`window.pi.getInstances()`);
  const worker = (insts ?? []).find((t) => t.verifyWorker);
  if (worker) workerId = worker.id;
  const active = await evalJs(`document.querySelector('.terminal-tab.active .tab-name')?.textContent`);
  if (workerId && active === "verify") {
    activated = true;
    break;
  }
}
check("worker pane auto-activates", activated === true, `worker=${workerId}`);

// ---- 2. interrupt the run ----
if (workerId) {
  await evalJs(`window.pi.writeTerminal('${workerId}', '\\x03')`);
} else {
  check("worker exists", false, "no worker found");
}
let verify = null;
for (let i = 0; i < 30; i++) {
  await sleep(500);
  const insts = await evalJs(`window.pi.getInstances()`);
  verify = (insts ?? []).find((t) => t.id === "term-1")?.verify ?? null;
  if (verify && verify.state !== "running") break;
}
check("state becomes cancelled", verify?.state === "cancelled", JSON.stringify(verify));

const badge = await evalJs(
  `(() => { const b = document.getElementById('verify-badge'); return { text: b.textContent, cls: b.className, hidden: b.hidden }; })()`,
);
check("badge shows the cancelled state", !badge.hidden && String(badge.text).includes("cancelled"), JSON.stringify(badge));

// ---- 3. no context file for a cancelled run ----
await sleep(400);
check("no verify context written for a cancelled run", !existsSync(ctxFile), "");

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
