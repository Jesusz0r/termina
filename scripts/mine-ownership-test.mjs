/**
 * "Mine" file ownership e2e test.
 *
 * Launch requirement:
 *   TERMINA_EVENTS_DIR=/tmp/termina-events-test
 *   TERMINA_INITIAL_CWD=<fresh fixture: greeting.ts, hello.txt, src/>
 *   --remote-debugging-port=9222
 *
 * Steps:
 *   1. Opening a file shows the mine toggle on its tab; clicking it marks
 *      the file as the user's own.
 *   2. The mine context file lists the file; the agent's next run receives
 *      the "Your files" context (session record).
 *   3. Clicking the toggle again clears the mark.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const mineFile = join("/tmp/termina-events-test", "mine-term-1.md");
const greetingAbs = "/tmp/termina-test-project/greeting.ts";

const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };

// ---- 1. open the file, click the mine toggle ----
await evalJs(`(() => { const rows = [...document.querySelectorAll('#explorer-tree .explorer-row.file')]; rows.find(r => r.querySelector('.explorer-name')?.textContent === 'greeting.ts')?.click(); })()`);
await sleep(900);
const hasMineBtn = await evalJs(`[...document.querySelectorAll('.editor-tab .tab-mine')].some(b => b.closest('.editor-tab')?.querySelector('.tab-name')?.textContent === 'greeting.ts')`);
check("the tab shows the mine toggle", hasMineBtn === true, "");
await evalJs(`(() => { const btn = [...document.querySelectorAll('.editor-tab .tab-mine')].find(b => b.closest('.editor-tab')?.querySelector('.tab-name')?.textContent === 'greeting.ts'); btn?.click(); })()`);
await sleep(600);
const mineState = await evalJs(`(() => { const tab = [...document.querySelectorAll('.editor-tab')].find(t => t.querySelector('.tab-name')?.textContent === 'greeting.ts'); return { cls: tab?.className, files: window.pi ? null : null }; })()`);
check("the tab marks the file as mine", String(mineState.cls).includes("mine"), JSON.stringify(mineState));
const listed = await evalJs(`window.pi.getMineFiles()`);
check("main knows the file is mine", Array.isArray(listed) && listed.some((p) => p.endsWith("greeting.ts")), JSON.stringify(listed));

// ---- 2. the context file + agent injection ----
await sleep(400);
const ctx = existsSync(mineFile) ? readFileSync(mineFile, "utf8") : "";
check("the mine context lists the file", ctx.includes("greeting.ts") && ctx.includes("Do not modify"), ctx.slice(0, 120));

await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", { text: "Read greeting.ts and report what it says." });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const busy = await evalJs(`document.getElementById('status-state').textContent`);
  if (busy && !busy.includes("working") && i > 5) break;
}
await sleep(1500);
const sessionDir = execSync(`ls -td ${process.env.HOME}/.pi/agent/sessions/--private-tmp-termina-test-project--/ 2>/dev/null | head -1`).toString().trim();
const sessionFile = execSync(`ls -t "${sessionDir}"*.jsonl 2>/dev/null | head -1`).toString().trim();
const session = sessionFile ? readFileSync(sessionFile, "utf8") : "";
check("the agent receives the 'Your files' context", session.includes("Your files") && session.includes("greeting.ts"), session.slice(0, 80));

// ---- 3. unmark ----
await evalJs(`(() => { const btn = [...document.querySelectorAll('.editor-tab .tab-mine')].find(b => b.closest('.editor-tab')?.querySelector('.tab-name')?.textContent === 'greeting.ts'); btn?.click(); })()`);
await sleep(600);
const listed2 = await evalJs(`window.pi.getMineFiles()`);
check("the mark clears", Array.isArray(listed2) && !listed2.some((p) => p.endsWith("greeting.ts")), JSON.stringify(listed2));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
