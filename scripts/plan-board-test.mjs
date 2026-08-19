/**
 * Plan Board e2e test.
 *
 * Launch requirement:
 *   TERMINA_INITIAL_CWD=<fresh fixture: greeting.ts "hello", hello.txt, src/>
 *   --remote-debugging-port=9222
 *
 * Steps:
 *   1. The agent is asked to make a plan first, then implement it
 *      (utils.ts + greeting.ts).
 *   2. The plan panel shows the tasks parsed from the plan message.
 *   3. Tasks whose files were touched become done when the run settles.
 *   4. Clicking a pending task dispatches that one task.
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

// ---- 1. run the agent with an explicit plan ----
await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", {
  text: "Make a plan with checkbox tasks first, then implement it. The plan must mention the files by name. Tasks: create utils.ts with an add function, then edit greeting.ts so the greeting is hi there.",
});
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
let seenWorking = false;
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const busy = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
  if (busy.includes("working")) seenWorking = true;
  if (seenWorking && !busy.includes("working")) break;
}
await sleep(1500);

// ---- 2. the plan panel shows tasks ----
const panel = JSON.parse(
  await evalJs(
    `(() => JSON.stringify({
      collapsed: document.getElementById('plan-panel').classList.contains('collapsed'),
      count: document.getElementById('plan-count').textContent,
      tasks: [...document.querySelectorAll('#plan-list .plan-task')].map(t => ({ text: t.querySelector('.plan-text')?.textContent, cls: t.className })),
    }))()`,
  ),
);
check("plan panel shows tasks", panel.tasks.length >= 2, JSON.stringify(panel));
const taskTexts = (panel.tasks ?? []).map((t) => t.text ?? "");
check("plan mentions utils.ts", taskTexts.some((t) => t.includes("utils.ts")), taskTexts.join(" | "));
check("plan mentions greeting.ts", taskTexts.some((t) => t.includes("greeting.ts")), taskTexts.join(" | "));

// ---- 3. done after the run settles ----
// The agent can auto-retry and re-plan mid-test (the plan text may change).
// Poll until both tasks reach done instead of sampling once.
let utilsDone = false;
let greetingDone = false;
let lastUtils = null;
let lastGreeting = null;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  const tasks = await evalJs(`[...document.querySelectorAll('#plan-list .plan-task')].map(t => ({ text: t.querySelector('.plan-text')?.textContent ?? '', cls: t.className }))`);
  lastUtils = tasks.find((t) => t.text.includes("utils.ts")) ?? null;
  lastGreeting = tasks.find((t) => t.text.includes("greeting.ts")) ?? null;
  utilsDone = !!lastUtils && lastUtils.cls.includes("state-done");
  greetingDone = !!lastGreeting && lastGreeting.cls.includes("state-done");
  if (utilsDone && greetingDone) break;
}
check("utils.ts task is done", utilsDone, JSON.stringify(lastUtils));
check("greeting.ts task is done", greetingDone, JSON.stringify(lastGreeting));

// ---- 4. click a pending task dispatches that task ----
// Re-query the live list (the plan may have been re-posted by a retry).
const pendingTask = await evalJs(`(() => {
  const items = [...document.querySelectorAll('#plan-list .plan-task')];
  const i = items.findIndex((t) => t.classList.contains('dispatchable') && !t.classList.contains('state-active') && !t.classList.contains('state-done'));
  return i;
})()`);
if (pendingTask !== -1) {
  await evalJs(`(() => { const items = [...document.querySelectorAll('#plan-list .plan-task')]; items[${pendingTask}]?.click(); })()`);
  let dispatched = false;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    dispatched = await evalJs(`!!document.querySelector('#plan-list .plan-task.state-active, #plan-list .plan-meta') || [...document.querySelectorAll('.terminal-tab')].some(t => (t.title || '').includes('dispatch'))`);
    if (dispatched) break;
  }
  check("clicking a task dispatches it", dispatched, "no dispatch worker or active claim after click");
} else {
  check("clicking a task dispatches it", false, "no pending task to click");
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
