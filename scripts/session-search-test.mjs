/**
 * Session Search e2e test.
 *
 * Launch requirement:
 *   TERMINA_INITIAL_CWD=<fresh fixture: greeting.ts "hello", hello.txt, src/>
 *   --remote-debugging-port=9222
 *
 * Steps:
 *   1. The agent creates utils.ts (with a function named compute) and edits
 *      greeting.ts, producing a session file.
 *   2. searchSessions("compute") returns hits, one resolving to utils.ts.
 *   3. searchSessions("greeting") returns hits resolving to greeting.ts.
 *   4. The modal renders hits; clicking one opens its file in the editor.
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

// ---- 1. run the agent (creates the session) ----
await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", { text: "Create utils.ts with a function named compute, then edit greeting.ts so the greeting is hi there." });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const busy = await evalJs(`document.getElementById('status-state').textContent`);
  if (busy && !busy.includes("working") && i > 5) break;
}
await sleep(1500);

// ---- 2. IPC search ----
const hits1 = await evalJs(`window.pi.searchSessions('compute')`);
check("search finds the word", Array.isArray(hits1) && hits1.length >= 1, JSON.stringify(hits1?.slice(0, 2)));
check("a hit resolves to utils.ts", (hits1 ?? []).some((h) => h.filePath === "utils.ts"), JSON.stringify((hits1 ?? []).map((h) => h.filePath).slice(0, 5)));
check("hits carry context", (hits1 ?? []).some((h) => typeof h.before === "string" && typeof h.after === "string"), "");

const hits2 = await evalJs(`window.pi.searchSessions('greeting')`);
check("search finds greeting", (hits2 ?? []).some((h) => h.filePath === "greeting.ts"), JSON.stringify((hits2 ?? []).map((h) => h.filePath).slice(0, 5)));

// ---- 3. the modal renders and clicks open ----
await evalJs(`window.__sessionSearch.open()`);
await evalJs(`(() => { const i = document.querySelector('.search-modal .search-input'); i.value = 'compute'; i.dispatchEvent(new Event('input')); })()`);
let rows = [];
for (let i = 0; i < 20; i++) {
  await sleep(300);
  rows = await evalJs(`[...document.querySelectorAll('.search-modal .search-hit')].map(r => ({ path: r.querySelector('.search-path')?.textContent, text: r.querySelector('.search-text')?.textContent.slice(0, 60) }))`);
  if (rows.length > 0) break;
}
check("modal renders hits", rows.length >= 1, JSON.stringify(rows.slice(0, 2)));
const utilsRow = rows.find((r) => r.path === "utils.ts");
if (utilsRow) {
  const idx = rows.indexOf(utilsRow);
  await evalJs(`(() => { const rows = [...document.querySelectorAll('.search-modal .search-hit')]; rows[${idx}]?.click(); })()`);
  await sleep(900);
  const tabs = await evalJs(`[...document.querySelectorAll('.editor-tab .tab-name')].map(t => t.textContent)`);
  check("clicking a hit opens its file", tabs.includes("utils.ts"), JSON.stringify(tabs));
} else {
  check("clicking a hit opens its file", false, "no utils.ts row");
}
// close the modal
await evalJs(`(() => { const b = document.querySelector('.search-modal'); if (b) b.style.display = 'none'; })()`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
