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

// focus the xterm and type a prompt
await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", { text: "Create a file called tui-test.txt containing the text hello from the tui" });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

// wait for the run to settle
for (let i = 0; i < 150; i++) {
  await sleep(1000);
  const busy = await evalJs(`document.getElementById('status-state').textContent`);
  if (busy && !busy.includes('working') && i > 3) break;
}
await sleep(1500);

const state = await evalJs(`
  (() => {
    const tabs = [...document.querySelectorAll('.editor-tab .tab-name')].map(t => t.textContent);
    const modified = [...document.querySelectorAll('#modified-list li .path')].map(p => p.textContent);
    return JSON.stringify({ tabs, modified });
  })()
`);
const { tabs, modified } = JSON.parse(state);
check("file auto-opened in editor mid-run", tabs.includes("tui-test.txt"), tabs.join(", "));
check("modified panel has the file", modified.some(m => m.includes("tui-test.txt")), modified.join(", "));

// file on disk?
const fs = await import("node:fs");
const disk = fs.existsSync("/tmp/pi-editor-test-project/tui-test.txt") ? fs.readFileSync("/tmp/pi-editor-test-project/tui-test.txt", "utf8") : null;
check("file created on disk", disk?.includes("hello from the tui"), JSON.stringify(disk));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
