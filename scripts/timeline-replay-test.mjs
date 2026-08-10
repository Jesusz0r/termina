/**
 * Session Timeline replay e2e test.
 *
 * Launch requirement:
 *   PI_EDITOR_EVENTS_DIR=/tmp/pi-editor-events-test
 *   PI_EDITOR_INITIAL_CWD=<fresh fixture: greeting.ts, hello.txt, src/>
 *   --remote-debugging-port=9222
 *
 * Steps (synthetic sidecar events, three file edits):
 *   1. Three tool dots appear in the strip.
 *   2. Replay opens each snapshot in ONE tab (the previous tab is replaced).
 *   3. The active dot stays visible in the strip during replay.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const eventsDir = "/tmp/pi-editor-events-test";
mkdirSync(eventsDir, { recursive: true });
const sidecar = join(eventsDir, "term-1.jsonl");
const bridgeId = "synthetic-timeline";
let sequence = 0;
const emit = (obj) => appendFileSync(sidecar, JSON.stringify({ bridgeId, seq: ++sequence, ...obj }) + "\n");

const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };

// ---- synthetic run with three edits ----
emit({ t: "agent_start" });
await sleep(400);
for (const [i, file] of ["greeting.ts", "hello.txt", "src/index.ts"].entries()) {
  emit({
    t: "tool",
    toolName: "edit",
    path: file,
    edits: [{ oldText: `old-${i}`, newText: `new-${i}` }],
  });
  await sleep(400);
}
emit({ t: "agent_settled" });
await sleep(800);

// ---- 1. three tool dots ----
const dots = await evalJs(`[...document.querySelectorAll('#timeline-dots .timeline-dot.t-tool')].length`);
check("three tool dots in the strip", dots === 3, `dots=${dots}`);

// ---- 2. replay keeps ONE tab ----
await evalJs(`document.getElementById('btn-timeline-play').click()`);
await sleep(2600); // ~4 steps at 650 ms
const tabsDuring = await evalJs(`document.querySelectorAll('.editor-tab.timeline-tab').length`);
check("replay keeps a single snapshot tab", tabsDuring <= 1, `tabs=${tabsDuring}`);
await evalJs(`document.getElementById('btn-timeline-play').click()`); // stop replay
await sleep(300);

// ---- 3. the active dot is visible ----
const vis = JSON.parse(
  await evalJs(
    `(() => {
      const d = document.getElementById('timeline-dots');
      const active = d.querySelector('.timeline-dot.active');
      if (!active) return JSON.stringify({ active: false });
      const r = active.getBoundingClientRect();
      const c = d.getBoundingClientRect();
      return JSON.stringify({ active: true, inView: r.left >= c.left - 2 && r.right <= c.right + 2, left: Math.round(r.left), right: Math.round(r.right), strip: [Math.round(c.left), Math.round(c.right)] });
    })()`,
  ),
);
check("active dot stays in view", vis.active === true && vis.inView === true, JSON.stringify(vis));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
