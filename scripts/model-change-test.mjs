// Verify model-change feedback in the terminal.
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
      res.on("error", reject);
    });
  });

const targets = await getJson("http://localhost:9222/json");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expression) => {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.result?.exceptionDetails) console.error("EXC:", JSON.stringify(res.result.exceptionDetails).slice(0, 200));
  return res.result?.result?.value;
};

// 1. capture the model before
const before = await evalJs(`document.getElementById('status-model').textContent`);
console.log("model before:", before);

// 2. change the model via the dropdown
const changed = await evalJs(`
  (() => {
    const sel = document.getElementById('model-select');
    const target = [...sel.options].find(o => o.value.includes('glm-5.2'));
    if (!target) return 'not-found';
    sel.value = target.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return target.value;
  })()
`);
console.log("changed to:", changed);

// 3. wait for set_model + refreshState round trip
await sleep(4000);

// 4. read terminal lines mentioning model changes
const after = await evalJs(`
  (() => {
    const term = window.__piTerminal;
    const b = term.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) {
      const t = b.getLine(i)?.translateToString(true) ?? '';
      if (t.includes('model:') || t.includes('thinking:')) lines.push(t.trim());
    }
    return JSON.stringify({
      lines,
      statusModel: document.getElementById('status-model').textContent,
      selectValue: document.getElementById('model-select').value,
    });
  })()
`);
console.log("result:", after);

// 5. switch thinking level too
await evalJs(`
  (() => {
    const sel = document.getElementById('thinking-select');
    if (sel.options.length > 1) {
      sel.value = sel.options[sel.options.length - 1].value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return 'ok';
  })()
`);
await sleep(3000);
const final = await evalJs(`
  (() => {
    const term = window.__piTerminal;
    const b = term.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) {
      const t = b.getLine(i)?.translateToString(true) ?? '';
      if (t.includes('thinking:')) lines.push(t.trim());
    }
    return JSON.stringify(lines);
  })()
`);
console.log("thinking lines:", final);
process.exit(0);