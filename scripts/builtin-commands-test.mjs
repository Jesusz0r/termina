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

const runCommand = async (cmd) => {
  await evalJs(`(() => { const i = document.getElementById('prompt-input'); i.value = ${JSON.stringify(cmd)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); })()`);
  await sleep(2500);
  return evalJs(`
    (() => {
      const term = window.__piTerminal;
      const b = term.buffer.active;
      let out = '';
      for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? '') + '\\n';
      return out;
    })()
  `);
};

// 1. builtins appear in the autocomplete
await evalJs(`(() => { const i = document.getElementById('prompt-input'); i.value = '/'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await sleep(1200);
const names = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#command-menu .cmd-name')].map(n => n.textContent))`));
check("builtins listed in / menu", names.includes("/help") && names.includes("/compact") && names.includes("/stats") && names.includes("/settings") && names.includes("/login"), names.slice(0, 8).join(", "));

// 2. /help prints the builtin list
const helpText = await runCommand("/help");
check("/help lists builtins", helpText.includes("built-in commands") && helpText.includes("/compact"), "");

// 3. /stats prints session stats
const statsText = await runCommand("/stats");
check("/stats shows token usage", statsText.includes("tokens:") || statsText.includes("cost:"), statsText.split("\n").filter(l => l.includes("tokens") || l.includes("cost")).slice(-2).join(" | "));

// 4. /models lists models
const modelsText = await runCommand("/models");
check("/models lists models", modelsText.includes("available models") && modelsText.includes("opencode-go"), "");

// 5. /session-name renames
const nameText = await runCommand("/session-name my-test-session");
check("/session-name works", nameText.includes("renamed"), "");

// 6. /clear clears the terminal buffer
await runCommand("/help"); // add content first
const before = await evalJs(`window.__piTerminal.buffer.active.length`);
await runCommand("/clear");
const after = await evalJs(`window.__piTerminal.buffer.active.length`);
check("/clear empties the buffer", after < before, `before=${before} after=${after}`);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
