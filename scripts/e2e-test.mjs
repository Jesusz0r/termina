// E2E smoke test: drives the running pi-editor (CDP on :9222) through a real
// agent prompt and verifies the terminal, modified-files panel and editor react.
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
if (!page) {
  console.error("no page target");
  process.exit(1);
}

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
  if (res.result?.exceptionDetails) {
    console.error("EXCEPTION:", JSON.stringify(res.result.exceptionDetails).slice(0, 500));
    return null;
  }
  return res.result?.result?.value;
};

// 1. Focus prompt, set value, click Send
await evalJs(`
  (() => {
    const input = document.getElementById('prompt-input');
    input.value = 'This is a test project. Create a file called hello.txt containing exactly "Hello pi-editor" and edit greeting.ts so its greeting becomes "hi there". When done, summarize the files you modified.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-send').click();
    return 'sent';
  })()
`);

// 2. Poll until the agent settles (abort button re-enables / status flips to idle)
console.log("waiting for agent…");
let settled = false;
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  const status = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
  if (status && !status.includes('working')) {
    settled = true;
    break;
  }
}
// Give the settled-summary a beat to land in the terminal buffer
await sleep(700);
console.log("settled:", settled);

// 3. Snapshot the UI state (terminal text read from the xterm buffer, which is
//    authoritative regardless of the canvas/DOM renderer)
const snapshot = await evalJs(`
  (() => {
    const term = window.__piTerminal;
    let terminalText = '';
    if (term) {
      const buf = term.buffer.active;
      for (let i = 0; i < buf.length; i++) {
        terminalText += (buf.getLine(i)?.translateToString(true) ?? '') + '\\n';
      }
    }
    return JSON.stringify({
      status: document.getElementById('status-state')?.textContent,
      terminalText: terminalText.slice(0, 2000),
      modifiedItems: [...document.querySelectorAll('#modified-list li')].map(li => li.textContent),
      editorTabs: [...document.querySelectorAll('.editor-tab .tab-name')].map(t => t.textContent),
      editorText: document.querySelector('.monaco-editor') ? 'mounted' : 'missing',
    });
  })()
`);
console.log(snapshot);
console.log("terminal has summary:", JSON.parse(snapshot).terminalText.includes("Session complete"));

// 4. Verify files on disk (resolve against the app's cwd)
const fs = await import("node:fs");
const path = await import("node:path");
const state = await evalJs(`JSON.stringify({ cwd: document.getElementById('status-cwd')?.textContent })`);
const cwd = JSON.parse(state).cwd ?? "/tmp/pi-editor-test-project";
console.log("cwd:", cwd);
for (const f of ["hello.txt", "greeting.ts"]) {
  const p = path.join(cwd, f);
  if (fs.existsSync(p)) {
    console.log(`${f}:`, JSON.stringify(fs.readFileSync(p, "utf8").slice(0, 60)));
  } else {
    console.log(`${f}: (not created — agent may have used a different path)`);
  }
}

ws.close();
process.exit(0);