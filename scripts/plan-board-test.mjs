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
 *
 * The live model varies between plan-only turns, missing plans, and full
 * implementations. Each phase therefore nudges the agent until it reaches
 * the required state instead of assuming one behavior:
 *   - no plan posted      -> resend the plan request once
 *   - plan but no work    -> send "implement the full plan now"
 *   - everything done     -> a second plan is interrupted mid-flight so a
 *                            pending task exists to click
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

const focusTerminal = () => evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
const typeLine = async (text) => {
  await focusTerminal();
  await send("Input.insertText", { text });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
};
const statusText = () => evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
const taskCount = () => evalJs(`document.querySelectorAll('#plan-list .plan-task').length`);

/** Wait until the status leaves "working" (a working sighting required). */
const waitSettled = async (maxSeconds) => {
  let seenWorking = false;
  for (let i = 0; i < maxSeconds; i++) {
    await sleep(1000);
    const s = String(await statusText());
    if (s.includes("working")) seenWorking = true;
    if (seenWorking && !s.includes("working")) return true;
  }
  return false;
};

/** Send Escape until the run settles. Returns true once settled. */
const interrupt = async () => {
  for (let i = 0; i < 3; i++) {
    await focusTerminal();
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    if (await waitSettled(20)) return true;
  }
  return false;
};

const sampleTasks = () =>
  evalJs(`[...document.querySelectorAll('#plan-list .plan-task')].map(t => ({ text: t.querySelector('.plan-text')?.textContent ?? '', cls: t.className }))`);

// ---- 1 + 2. get a plan posted ----
// The prompt contains the literal checklist lines: models copy them
// verbatim, which guarantees parseable unchecked boxes.
const PLAN_PROMPT = [
  "First reply with this exact plan, then implement it:",
  "- [ ] Create utils.ts with an add function",
  "- [ ] Edit greeting.ts so the greeting is hi there",
  "Implement both tasks right after the plan in the same turn.",
].join("\n");
let sawPlan = false;
for (let attempt = 0; attempt < 3 && !sawPlan; attempt++) {
  await typeLine(PLAN_PROMPT);
  let seenWorking = false;
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const s = String(await statusText());
    if (s.includes("working")) seenWorking = true;
    if ((await taskCount()) > 0) { sawPlan = true; break; }
    if (seenWorking && !s.includes("working")) break;
  }
  if (!sawPlan) await interrupt();
}
await sleep(1500);

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

if (!sawPlan) {
  // Without a plan the remaining checks cannot run; fail fast and loudly.
  check("utils.ts task is done", false, "no plan was ever posted");
  check("greeting.ts task is done", false, "no plan was ever posted");
} else {
  // ---- 3. drive the implementation until both tasks are done ----
  // A plan-only turn settles with every task pending; nudge the agent
  // back to work instead of failing.
  let utilsDone = false;
  let greetingDone = false;
  let lastUtils = null;
  let lastGreeting = null;
  let nags = 0;
  let seenWorking = false;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const s = String(await statusText());
    if (s.includes("working")) seenWorking = true;
    const tasks = await sampleTasks();
    lastUtils = tasks.find((t) => t.text.includes("utils.ts")) ?? null;
    lastGreeting = tasks.find((t) => t.text.includes("greeting.ts")) ?? null;
    utilsDone = !!lastUtils && lastUtils.cls.includes("state-done");
    greetingDone = !!lastGreeting && lastGreeting.cls.includes("state-done");
    if (utilsDone && greetingDone) break;
    const settledNow = seenWorking && !s.includes("working");
    if (settledNow && nags < 3) {
      nags++;
      seenWorking = false;
      await typeLine(
        "Do not write a plan or any checklist. Use tools right now to implement the existing plan: create utils.ts with an add function, then edit greeting.ts so the greeting is hi there.",
      );
    }
  }
  check("utils.ts task is done", utilsDone, JSON.stringify(lastUtils));
  check("greeting.ts task is done", greetingDone, JSON.stringify(lastGreeting));
}

// ---- 4. click a pending task dispatches that task ----
// Guarantee a pending task deterministically: ask for a checklist-only
// reply. The board parses the unchecked boxes, the turn settles without
// touching any file, and finalize never marks the tasks done.
const pendingBefore = await evalJs(`(() => {
  const items = [...document.querySelectorAll('#plan-list .plan-task')];
  return items.findIndex((t) => t.classList.contains('dispatchable') && !t.classList.contains('state-active') && !t.classList.contains('state-done'));
})()`);
if (pendingBefore === -1) {
  await typeLine(
    "Do not use any tools. Reply with only a markdown checklist of three follow-up ideas for this project. Every line must be an unchecked item formatted exactly like '- [ ] the idea'.",
  );
  await waitSettled(90);
}

// Re-query the live list (the plan may have been re-posted by a retry).
const pendingTask = await evalJs(`(() => {
  const items = [...document.querySelectorAll('#plan-list .plan-task')];
  const i = items.findIndex((t) => t.classList.contains('dispatchable') && !t.classList.contains('state-active') && !t.classList.contains('state-done'));
  return i;
})()`);
if (pendingTask !== -1) {
  await evalJs(`(() => { const items = [...document.querySelectorAll('#plan-list .plan-task')]; items[${pendingTask}]?.click(); })()`);
  let dispatched = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
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
