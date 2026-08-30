/**
 * Feature #5 e2e test: your edits reach the agent.
 *
 * Launch requirement:
 *   TERMINA_EVENTS_DIR=/tmp/termina-events-test
 *   TERMINA_INITIAL_CWD=<fresh fixture: greeting.ts "hello", hello.txt, src/>
 *   --remote-debugging-port=9222
 *
 * Steps:
 *   1. A user edit while idle writes the edits-<id>.md context file with
 *      before/after content.
 *   2. The agent's next run receives the context (session record contains
 *      "Your edits").
 *   3. The run consumes the context: the file is cleared after settle.
 *   4. A user edit DURING a busy run is not recorded (no file after settle).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const eventsDir = process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-events-test";
const editsFile = join(eventsDir, "edits-term-1.md");
const greeting = "/tmp/termina-test-project/greeting.ts";
// The fixture project gains a test script whose run writes a file (test
// output). The write must NOT be recorded as a user edit.
writeFileSync(
  "/tmp/termina-test-project/package.json",
  JSON.stringify({ name: "edits-fixture", scripts: { test: "node -e \"require('fs').writeFileSync('from-test.txt','x');setTimeout(()=>{},5000)\"" } }),
);

const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const waitIdle = async () => {
  // Require a working → idle transition: an idle sample alone could mean
  // the agent never started (a stale session then corrupts the checks).
  let seenWorking = false;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const busy = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
    if (busy.includes("working")) seenWorking = true;
    if (seenWorking && !busy.includes("working")) return;
  }
};
const promptAgent = async (text) => {
  await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
  await send("Input.insertText", { text });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitIdle();
  await sleep(1200);
};

// ---- 1. user edit while idle → context file ----
writeFileSync(greeting, 'export const greeting = "hi there";\n');
let ctx1 = "";
for (let i = 0; i < 20; i++) {
  await sleep(200);
  if (existsSync(editsFile)) {
    ctx1 = readFileSync(editsFile, "utf8");
    break;
  }
}
check("user edit writes the context file", ctx1.includes("## Your edits") && ctx1.includes("greeting.ts"), ctx1.slice(0, 120));
// A second edit updates the after side while preserving the first pre-edit
// state for the whole idle editing burst.
writeFileSync(greeting, 'export const greeting = "hi again";\n');
let ctx2 = "";
for (let i = 0; i < 20; i++) {
  await sleep(200);
  const current = existsSync(editsFile) ? readFileSync(editsFile, "utf8") : "";
  if (current.includes("hi again")) {
    ctx2 = current;
    break;
  }
}
check(
  "context preserves first before and latest after content",
  ctx2.includes('export const greeting = "hello";') && ctx2.includes('export const greeting = "hi again";'),
  ctx2.slice(0, 200),
);

// ---- 2. the agent receives the context ----
await promptAgent("Read greeting.ts and report what it says.");
const sessionDir = execSync(`ls -td ${process.env.HOME}/.pi/agent/sessions/--private-tmp-termina-test-project--/ 2>/dev/null | head -1`).toString().trim();
const sessionFile = execSync(`ls -t "${sessionDir}"*.jsonl 2>/dev/null | head -1`).toString().trim();
const session = sessionFile ? readFileSync(sessionFile, "utf8") : "";
check("session record contains the injected edits context", session.includes("Your edits") && session.includes("greeting.ts"), session.slice(0, 80));

// ---- 3. the run consumed the context ----
// The clear happens at agent_start; the run can start a few seconds after
// the prompt (model latency), so poll instead of sampling once.
let cleared = false;
for (let i = 0; i < 30; i++) {
  await sleep(300);
  if (!existsSync(editsFile)) {
    cleared = true;
    break;
  }
}
check("context file cleared after the run", cleared, "");

// ---- 4. a user edit during a busy run is not recorded ----
// Mark the terminal busy deterministically with a synthetic agent_start
// (same shape the bridge extension writes), then write mid-run.
const { appendFileSync } = await import("node:fs");
const sidecar = join(eventsDir, "term-1.jsonl");
const bridgeId = "synthetic-edits";
let sequence = 0;
const emit = (event) => appendFileSync(sidecar, JSON.stringify({ bridgeId, seq: ++sequence, ...event }) + "\n");
emit({ t: "agent_start" });
await sleep(600);
writeFileSync("/tmp/termina-test-project/hello.txt", "user edit mid-run\n");
await sleep(1200); // watcher debounce + edit debounce + context write
emit({ t: "agent_settled" });
await sleep(600);
check("mid-run user edit is not recorded", !existsSync(editsFile), "");

// ---- 5. verify-run outputs are not user edits ----
const run = await evalJs(`window.pi.runVerify('term-1')`);
check("verify starts ok", run?.ok === true, JSON.stringify(run));
await sleep(2500); // the worker writes from-test.txt mid-run
await sleep(1200);
const ctx5 = existsSync(editsFile) ? readFileSync(editsFile, "utf8") : "";
check("verify-run outputs are not recorded as user edits", !ctx5.includes("from-test.txt"), ctx5.slice(0, 120));
// Wait for the worker to finish so the fixture state is clean.
await sleep(8000);

// ---- 6. a user deletion removes the stale edit entry ----
const { rmSync } = await import("node:fs");
writeFileSync(greeting, 'export const greeting = "hi three";\n');
let ctx6 = "";
for (let i = 0; i < 20; i++) {
  await sleep(250);
  const current = existsSync(editsFile) ? readFileSync(editsFile, "utf8") : "";
  if (current.includes("hi three")) {
    ctx6 = current;
    break;
  }
}
check("the edit is recorded before the deletion", ctx6.includes("greeting.ts"), ctx6.slice(0, 80));
rmSync(greeting);
let ctx6b = "";
for (let i = 0; i < 20; i++) {
  await sleep(250);
  const current = existsSync(editsFile) ? readFileSync(editsFile, "utf8") : "";
  if (!current.includes("greeting.ts")) {
    ctx6b = current;
    break;
  }
}
check("a user deletion removes the stale edit entry", !ctx6b.includes("greeting.ts") && !ctx6b.includes("hi three"), ctx6b.slice(0, 80));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
