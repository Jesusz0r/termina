/**
 * Dispatch (parallel agents) e2e test.
 *
 * Launch requirement:
 *   PI_EDITOR_INITIAL_CWD=<fresh fixture: greeting.ts "hello", hello.txt, src/>
 *   --remote-debugging-port=9222
 *
 * Steps:
 *   1. The owner agent makes a plan (3 checkbox tasks with file paths) and
 *      does NOT execute it.
 *   2. dispatchRun sends each task to its own worker terminal.
 *   3. The tasks turn done as the workers settle; the workers' files land in
 *      the owner's Change Review.
 */
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. the owner makes a plan only ----
await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", {
  text: "Make a plan with checkbox tasks only, do NOT execute anything. Tasks: create utils.ts with an add function; create math.ts with a multiply function; edit greeting.ts so the greeting is hi there.",
});
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
let planTasks = [];
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  planTasks = await evalJs(`[...document.querySelectorAll('#plan-list .plan-task')].map(t => ({ text: t.querySelector('.plan-text')?.textContent ?? '', cls: t.className }))`);
  if (planTasks.length >= 3) break;
}
check("the plan board holds the tasks", planTasks.length >= 3, JSON.stringify(planTasks.map((t) => t.text).slice(0, 3)));

// ---- 2. dispatch ----
const run = await evalJs(`window.pi.dispatchRun('term-1')`);
check("dispatch starts", run?.ok === true && run?.dispatched === 3, JSON.stringify(run));

// ---- 3. workers appear, tasks finish, files collect ----
let workers = 0;
let done = 0;
for (let i = 0; i < 300; i++) {
  await sleep(1000);
  const insts = await evalJs(`window.pi.getInstances()`);
  workers = (insts ?? []).filter((t) => t.dispatchWorker).length;
  done = await evalJs(`[...document.querySelectorAll('#plan-list .plan-task.state-done')].length`);
  if (workers >= 3 && done >= 3) break;
}
check("three dispatch workers run", workers >= 3, `workers=${workers}`);
check("all dispatched tasks turn done", done >= 3, `done=${done}`);

// ---- 4. collection: the owner's review holds the workers' files ----
await sleep(1000);
const files = await evalJs(`[...document.querySelectorAll('#modified-list .path')].map(p => p.textContent)`);
check("worker files land in the owner's review", files.some((f) => f.includes("utils.ts")) && files.some((f) => f.includes("math.ts")), JSON.stringify(files));

const { existsSync, readFileSync } = await import("node:fs");
check("utils.ts exists on disk", existsSync("/tmp/pi-editor-test-project/utils.ts"), "");
check("math.ts exists on disk", existsSync("/tmp/pi-editor-test-project/math.ts"), "");
const greeting = existsSync("/tmp/pi-editor-test-project/greeting.ts") ? readFileSync("/tmp/pi-editor-test-project/greeting.ts", "utf8") : "";
check("greeting.ts was edited by its worker", greeting.includes("hi there"), greeting.slice(0, 60));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
