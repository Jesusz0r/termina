// Multi-terminal verification: instances are isolated (chat, modified files,
// model) and land on the project folder.
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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const promptActive = async (text) => {
  await evalJs(`(() => { const i = document.getElementById('prompt-input'); i.value = ${JSON.stringify(text)}; document.getElementById('btn-send').click(); })()`);
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    const st = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
    if (st && !st.includes('working') && i > 3) return;
  }
};

const activeTerminalText = async () =>
  await evalJs(`
    (() => {
      const term = window.__piTerminal;
      const b = term.buffer.active;
      let out = '';
      for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) ?? '') + '\\n';
      return out;
    })()
  `);

// 1. boot: one pane, one instance
const boot = JSON.parse(await evalJs(`
  (async () => JSON.stringify({
    tabs: document.querySelectorAll('.terminal-tab').length,
    instances: (await window.pi.getInstances()).length,
    cwd: document.getElementById('status-cwd').textContent,
  }))()
`));
check("boot has one terminal pane", boot.tabs === 1 && boot.instances === 1, JSON.stringify(boot));

// 2. create a second instance — lands on the project folder
await evalJs(`window.pi.createInstance()`);
await sleep(2500);
const afterCreate = JSON.parse(await evalJs(`
  (async () => JSON.stringify({
    tabs: document.querySelectorAll('.terminal-tab').length,
    instances: (await window.pi.getInstances()).length,
    activeName: document.querySelector('.terminal-tab.active .tab-name')?.textContent,
    activeCwd: document.getElementById('status-cwd').textContent,
  }))()
`));
check("new terminal lands on project folder", afterCreate.tabs === 2 && afterCreate.instances === 2 && afterCreate.activeCwd.includes("pi-editor-test-project"), JSON.stringify(afterCreate));

// 3. prompt in pane 2 (active) — pane 1's chat must stay untouched
await promptActive('Reply with exactly: PANE-TWO-MARKER');
const activeText = await activeTerminalText();
check("pane 2 chat has the prompt+response", activeText.includes("PANE-TWO-MARKER") || activeText.includes("Reply with exactly"));
// switch to pane 1
await evalJs(`document.querySelectorAll('.terminal-tab')[0].click()`);
await sleep(500);
const pane1Text = await activeTerminalText();
check("pane 1 chat is isolated (no pane-2 content)", !pane1Text.includes("PANE-TWO-MARKER") && !pane1Text.includes("Reply with exactly"));

// 4. model isolation: change model on pane 1, pane 2 must keep its own
const modelBefore = await evalJs(`document.getElementById('status-model').textContent`);
await evalJs(`
  (() => {
    const sel = document.getElementById('model-select');
    const current = sel.value;
    // pick a model different from the current one
    const target = [...sel.options].find(o => o.value !== current);
    if (target) { sel.value = target.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  })()
`);
await sleep(3500);
const pane1Model = await evalJs(`document.getElementById('status-model').textContent`);
// switch to pane 2 and check its model is unchanged
await evalJs(`document.querySelectorAll('.terminal-tab')[1].click()`);
await sleep(500);
const pane2Model = await evalJs(`document.getElementById('status-model').textContent`);
check("model change isolated per instance", pane1Model !== modelBefore && pane2Model === modelBefore, `pane1=${pane1Model} pane2=${pane2Model} was=${modelBefore}`);

// 5. close pane 2
await evalJs(`document.querySelectorAll('.terminal-tab')[1].querySelector('.tab-close').click()`);
await sleep(1500);
const afterClose = JSON.parse(await evalJs(`
  (async () => JSON.stringify({ tabs: document.querySelectorAll('.terminal-tab').length, instances: (await window.pi.getInstances()).length }))()
`));
check("closing a terminal removes the instance", afterClose.tabs === 1 && afterClose.instances === 1, JSON.stringify(afterClose));

console.log("\n=== SUMMARY ===");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);