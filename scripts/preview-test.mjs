import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); res.on("error", reject); });
  req.on("error", reject);
});
const targets = await getJson("http://localhost:9222/json");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

const tabs = () => evalJs(`JSON.stringify([...document.querySelectorAll('.editor-tab')].map(t => ({ name: t.querySelector('.tab-name')?.textContent, preview: t.classList.contains('preview') })))`);
const clickFile = (name) => evalJs(`
  (() => {
    const rows = [...document.querySelectorAll('#explorer-tree .explorer-children .explorer-row')];
    const row = rows.find(r => r.querySelector('.explorer-name')?.textContent === '${name}');
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()
`);

// 1. click hello.txt → one preview tab
await clickFile("hello.txt");
await sleep(600);
let t = JSON.parse(await tabs());
check("click opens a preview tab", t.length === 1 && t[0].name === "hello.txt" && t[0].preview, JSON.stringify(t));

// 2. click greeting.ts → replaces the preview (still ONE tab)
await clickFile("greeting.ts");
await sleep(600);
t = JSON.parse(await tabs());
check("second click replaces the preview", t.length === 1 && t[0].name === "greeting.ts" && t[0].preview, JSON.stringify(t));

// 3. edit the preview → becomes permanent (real keystrokes via CDP)
const editorRect = JSON.parse(await evalJs(`(() => { const r = document.querySelector('.monaco-editor').getBoundingClientRect(); return JSON.stringify({ x: r.x + 80, y: r.y + 60 }); })()`));
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: editorRect.x, y: editorRect.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: editorRect.x, y: editorRect.y, button: "left", clickCount: 1 });
await send("Input.insertText", { text: "// edited by user" });
await sleep(600);
t = JSON.parse(await tabs());
check("editing pins the preview", t.length === 1 && t[0].name === "greeting.ts" && !t[0].preview, JSON.stringify(t));

// 4. click another file → opens as NEW preview (pinned one stays)
await clickFile("hello.txt");
await sleep(600);
t = JSON.parse(await tabs());
check("new preview after pin", t.length === 2 && t.some(x => x.name === "hello.txt" && x.preview) && t.some(x => x.name === "greeting.ts" && !x.preview), JSON.stringify(t));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
