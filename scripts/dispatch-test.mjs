/**
 * Dispatch (parallel agents) e2e test.
 *
 * Launch requirement:
 *   TERMINA_INITIAL_CWD=<fresh fixture: greeting.ts "hello", hello.txt, src/>
 *   TERMINA_EVENTS_DIR=<events dir>
 *   TERMINA_E2E_PORT=<runner-assigned DevTools port>
 *
 * Steps:
 *   1. The owner agent makes a plan (3 checkbox tasks with file paths) and
 *      does NOT execute it.
 *   2. dispatchRun sends each task to its own worker terminal with a
 *      briefing mailbox and a per-terminal startup control.
 *   3. The tasks turn done as the workers settle; the workers' files land in
 *      the owner's Change Review. The owner mailbox records sibling settles.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { e2ePort } from "./e2e-port.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const eventsDir = process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-events-test";
const worldsDir = process.env.TERMINA_WORLDS_DIR ?? "";
const projectRoot = process.env.TERMINA_INITIAL_CWD;
if (!projectRoot) throw new Error("TERMINA_INITIAL_CWD is required");

const listMailboxFiles = (dir, acc = []) => {
  if (!dir || !existsSync(dir)) return acc;
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of names) {
    const p = join(dir, entry.name);
    if (entry.isFile() && entry.name.startsWith("mailbox-") && entry.name.endsWith(".md")) acc.push(p);
    else if (entry.isDirectory()) listMailboxFiles(p, acc);
  }
  return acc;
};

const readDispatchContext = () => {
  if (!existsSync(eventsDir)) return "";
  const parts = [];
  for (const name of readdirSync(eventsDir)) {
    if (!(name.startsWith("mailbox-") && name.endsWith(".md")) && !(name.startsWith("prompt-") && name.endsWith(".json"))) continue;
    try {
      parts.push(readFileSync(join(eventsDir, name), "utf8"));
    } catch {
      /* skip */
    }
  }
  return parts.join("\n");
};

const pages = await fetch(`http://127.0.0.1:${e2ePort()}/json`).then((r) => r.json());
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

let briefing = "";
for (let i = 0; i < 40; i++) {
  briefing = readDispatchContext();
  if (briefing.includes("## Dispatch briefing")) break;
  await sleep(100);
}
check("a worker mailbox carries the dispatch briefing", briefing.includes("## Dispatch briefing") && briefing.includes("Sibling path claims"), briefing.slice(0, 180));

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

check("utils.ts exists on disk", existsSync(join(projectRoot, "utils.ts")), "");
check("math.ts exists on disk", existsSync(join(projectRoot, "math.ts")), "");
const greetingPath = join(projectRoot, "greeting.ts");
const greeting = existsSync(greetingPath) ? readFileSync(greetingPath, "utf8") : "";
check("greeting.ts was edited by its worker", greeting.includes("hi there"), greeting.slice(0, 60));

const ownerMailbox = existsSync(join(eventsDir, "mailbox-term-1.md")) ? readFileSync(join(eventsDir, "mailbox-term-1.md"), "utf8") : "";
check(
  "the owner mailbox records a sibling settle",
  ownerMailbox.includes("## Sibling settled") && (ownerMailbox.includes("utils.ts") || ownerMailbox.includes("math.ts") || ownerMailbox.includes("greeting.ts")),
  ownerMailbox.slice(0, 180),
);

const worldlineMailboxes = worldsDir ? listMailboxFiles(worldsDir) : [];
check("worldline directories have no mailbox files", worldlineMailboxes.length === 0, worldlineMailboxes.join(", "));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
