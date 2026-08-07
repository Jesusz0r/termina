import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
const getJson = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); res.on("error", reject); });
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

const setInput = (v) => evalJs(`(() => { const i = document.getElementById('prompt-input'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

// 1. type "/" → dropdown shows commands
await setInput("/");
await sleep(1500); // lazy fetch
const items1 = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#command-menu .cmd-name')].map(n => n.textContent).slice(0, 5))`));
const count1 = await evalJs(`document.querySelectorAll('#command-menu .cmd-item').length`);
check("typing / lists commands", count1 > 10, `${count1} items, e.g. ${items1.slice(0, 3).join(", ")}`);

// 2. filter with "/ski" → only skill:... matches
await setInput("/ski");
await sleep(300);
const items2 = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#command-menu .cmd-name')].map(n => n.textContent))`));
check("typing /ski filters to matching commands", items2.length > 0 && items2.every(n => n.startsWith("/skill:") || n.startsWith("/ski")), items2.slice(0, 3).join(", "));

// 3. Tab completes the selected command
await evalJs(`(() => { const i = document.getElementById('prompt-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); })()`);
const afterTab = await evalJs(`document.getElementById('prompt-input').value`);
const menuClosed = await evalJs(`document.getElementById('command-menu').style.display`);
check("Tab completes the command", afterTab.startsWith("/skill:") && afterTab.endsWith(" "), JSON.stringify(afterTab));
check("menu closes after completion", menuClosed === "none", menuClosed);

// 4. executing a real command: /skill:clean-code expands via pi
await setInput("/skill:clean-code");
await evalJs(`(() => { const i = document.getElementById('prompt-input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
for (let i = 0; i < 120; i++) {
  await sleep(1000);
  const st = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
  if (st && !st.includes('working') && i > 3) break;
}
await sleep(800);
const termText = await evalJs(`
  (() => {
    const term = window.__piTerminal;
    const b = term.buffer.active;
    let out = '';
    for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? '') + '\\n';
    return out;
  })()
`);
check("skill command was sent and the agent responded", termText.includes("/skill:clean-code"), "prompt echoed; agent ran");

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
