/**
 * Verify & Iterate e2e test.
 *
 * Expects an Electron instance on :9222 with PI_EDITOR_INITIAL_CWD set to a
 * project with a failing `npm run test` script (see the test project setup
 * in the README/commits). Steps:
 *   1. detectTest() reports the npm test script
 *   2. runVerify() spawns a worker terminal, state goes running → fail
 *   3. the verify context file is written with FAILED + output
 *   4. after fixing the test on disk, verify again → pass + PASSED context
 *   5. the badge reflects the state in the DOM
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const port = 9222;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
};

const pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The events dir is app.getPath("temp")/pi-ditor-events — locate it by globbing.
// Re-glob every time: the dir may only be created mid-test by the app.
import { execSync } from "node:child_process";
const findEventsDir = () =>
  execSync(`find /var/folders -name "pi-ditor-events" -type d 2>/dev/null | head -1`).toString().trim();
const contextFile = (termId) => join(findEventsDir(), `verify-${termId}.md`);

// ---- 1. detection ----
const detected = await evalJs(`window.pi.detectTest()`);
check("detectTest finds the npm test script", detected?.label === "npm run test", JSON.stringify(detected));

// The UI button must be ENABLED at boot when tests exist (it used to stay
// disabled forever because the renderer never asked for the command).
await sleep(400);
const btn = await evalJs(
  `(() => { const b = document.getElementById('btn-verify'); return { disabled: b.disabled, title: b.title }; })()`,
);
check("Verify button enabled at boot", btn.disabled === false && btn.title.includes("npm run test"), JSON.stringify(btn));

// Restore the failing state (earlier runs may have fixed it).
writeFileSync("/tmp/pi-editor-verify-project/math.js", "exports.add = (a, b) => a + b + 1; // BUG\n");

// ---- 2. run verify → failing ----
const run1 = await evalJs(`window.pi.runVerify("term-1")`);
check("runVerify starts ok", run1?.ok === true, JSON.stringify(run1));

// state should move running → fail within ~15s (test fails immediately)
let verifyState = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const insts = await evalJs(`window.pi.getInstances()`);
  const owner = insts?.find((t) => t.id === "term-1");
  if (owner?.verify && owner.verify.state !== "running") {
    verifyState = owner.verify;
    break;
  }
}
check("verify state becomes fail", verifyState?.state === "fail", JSON.stringify(verifyState));

// The worker exits fast; its tab stays in the renderer though.
const tabs = await evalJs(`[...document.querySelectorAll('.terminal-tab .tab-name')].map((el) => el.textContent)`);
check("a worker terminal ran the tests", tabs.some((t) => t === "verify"), JSON.stringify(tabs));

// ---- 3. context file ----
await sleep(300);
const ctx1 = existsSync(contextFile("term-1")) ? readFileSync(contextFile("term-1"), "utf8") : "";
check("verify context file written", ctx1.includes("❌ FAILED"), ctx1.slice(0, 120));
check("context contains the failure output", ctx1.includes("FAIL: add"), ctx1.slice(0, 200));

// ---- 4. fix + verify again → green ----
// Simulate the agent fixing the bug (a real agent run does this via tools).
writeFileSync("/tmp/pi-editor-verify-project/math.js", "exports.add = (a, b) => a + b;\n");

const run2 = await evalJs(`window.pi.runVerify("term-1")`);
check("second runVerify starts ok", run2?.ok === true, JSON.stringify(run2));

let verifyState2 = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const insts = await evalJs(`window.pi.getInstances()`);
  const owner = insts?.find((t) => t.id === "term-1");
  if (owner?.verify && owner.verify.state !== "running") {
    verifyState2 = owner.verify;
    break;
  }
}
check("verify state becomes pass", verifyState2?.state === "pass", JSON.stringify(verifyState2));

await sleep(300);
const ctx2 = existsSync(contextFile("term-1")) ? readFileSync(contextFile("term-1"), "utf8") : "";
check("context file now PASSED", ctx2.includes("✅ PASSED"), ctx2.slice(0, 120));

// ---- 5. DOM badge ----
const badge = await evalJs(
  `(() => { const b = document.getElementById('verify-badge'); return { text: b.textContent, hidden: b.hidden, cls: b.className }; })()`,
);
check("statusbar badge shows the pass state", !badge.hidden && String(badge.text).includes("green"), JSON.stringify(badge));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
