/**
 * "Mine" file ownership e2e test.
 *
 * Launch requirement:
 *   TERMINA_EVENTS_DIR=/tmp/termina-events-test
 *   TERMINA_INITIAL_CWD=<fresh fixture: greeting.ts, hello.txt, src/>
 *   TERMINA_E2E_PORT=<runner-assigned DevTools port>
 *
 * Steps:
 *   1. Opening a file shows the mine toggle on its tab; clicking it marks
 *      the file as the user's own.
 *   2. The mine context file lists the file; the agent's next run receives
 *      the "Your files" context (session record).
 *   3. Clicking the toggle again clears the mark.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { e2ePort } from "./e2e-port.mjs";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const mineFile = join(process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-events-test", "mine-term-1.md");
const projectRoot = process.env.TERMINA_INITIAL_CWD;
if (!projectRoot) throw new Error("TERMINA_INITIAL_CWD is required");
const greetingAbs = join(projectRoot, "greeting.ts");
const sessionSlug = `--${realpathSync(projectRoot).replace(/^[/\\]+/, "").replace(/[/\\]+$/, "").replace(/[/\\:]/g, "-")}--`;
const sessionDir = join(homedir(), ".pi", "agent", "sessions", sessionSlug);
const latestSessionFile = () => {
  if (!existsSync(sessionDir)) return "";
  return readdirSync(sessionDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionDir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? "";
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
const owner = await evalJs(`window.pi.projectList().then((v) => { const p = v.find((x) => x.active); return p ? { projectId: p.id, workspaceId: p.workspaceId } : null; })`);

// ---- 1. open the file, click the mine toggle ----
await evalJs(`(() => { const rows = [...document.querySelectorAll('#explorer-tree .explorer-row.file')]; rows.find(r => r.querySelector('.explorer-name')?.textContent === 'greeting.ts')?.click(); })()`);
await sleep(900);
const hasMineBtn = await evalJs(`[...document.querySelectorAll('.editor-tab .tab-mine')].some(b => b.closest('.editor-tab')?.querySelector('.tab-name')?.textContent === 'greeting.ts')`);
check("the tab shows the mine toggle", hasMineBtn === true, "");
await evalJs(`(() => { const btn = [...document.querySelectorAll('.editor-tab .tab-mine')].find(b => b.closest('.editor-tab')?.querySelector('.tab-name')?.textContent === 'greeting.ts'); btn?.click(); })()`);
await sleep(600);
const mineState = await evalJs(`(() => { const tab = [...document.querySelectorAll('.editor-tab')].find(t => t.querySelector('.tab-name')?.textContent === 'greeting.ts'); return { cls: tab?.className, files: window.pi ? null : null }; })()`);
check("the tab marks the file as mine", String(mineState.cls).includes("mine"), JSON.stringify(mineState));
const listed = await evalJs(`window.pi.getMineFiles(${JSON.stringify(owner)})`);
check("main knows the file is mine", Array.isArray(listed) && listed.some((p) => p.endsWith("greeting.ts")), JSON.stringify(listed));

// ---- 2. the context file + agent injection ----
await sleep(400);
const ctx = existsSync(mineFile) ? readFileSync(mineFile, "utf8") : "";
check("the mine context lists the file", ctx.includes("greeting.ts") && ctx.includes("Do not modify"), ctx.slice(0, 120));

await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", { text: "Read greeting.ts and report what it says." });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
let seenWorking = false;
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const busy = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
  if (busy.includes("working")) seenWorking = true;
  if (seenWorking && !busy.includes("working")) break;
}
await sleep(1500);
const sessionFile = latestSessionFile();
const session = sessionFile ? readFileSync(sessionFile, "utf8") : "";
check("the agent receives the 'Your files' context", session.includes("Your files") && session.includes("greeting.ts"), session.slice(0, 80));

// ---- 3. unmark ----
await evalJs(`(() => { const btn = [...document.querySelectorAll('.editor-tab .tab-mine')].find(b => b.closest('.editor-tab')?.querySelector('.tab-name')?.textContent === 'greeting.ts'); btn?.click(); })()`);
await sleep(600);
const listed2 = await evalJs(`window.pi.getMineFiles(${JSON.stringify(owner)})`);
check("the mark clears", Array.isArray(listed2) && !listed2.some((p) => p.endsWith("greeting.ts")), JSON.stringify(listed2));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
