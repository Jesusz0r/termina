// Edge-case verification for the pi-editor review fixes.
// Requires the app running with --remote-debugging-port=9222.
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
  console.error("no page target — is the app running with --remote-debugging-port=9222?");
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
    console.error("EVAL EXCEPTION:", JSON.stringify(res.result.exceptionDetails).slice(0, 300));
  }
  return res.result?.result?.value;
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

const prompt = async (text) => {
  await evalJs(`(() => {
    const input = document.getElementById('prompt-input');
    input.value = ${JSON.stringify(text)};
    document.getElementById('btn-send').click();
  })()`);
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    const st = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
    if (st && !st.includes('working') && i > 2) return;
  }
};

const terminalText = async () => {
  return await evalJs(`
    (() => {
      const term = window.__piTerminal;
      if (!term) return '';
      const buf = term.buffer.active;
      let out = '';
      for (let i = 0; i < buf.length; i++) out += (buf.getLine(i)?.translateToString(true) ?? '') + '\\n';
      return out;
    })()
  `);
};

const tabs = async () => JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('.editor-tab .tab-name')].map(t => t.textContent))`));
const modifiedItems = async () => JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('#modified-list li')].map(li => li.textContent))`));

// ---------------------------------------------------------------------------
// 0. Reset: fresh session + fresh panel + no open tabs (self-contained test)
// ---------------------------------------------------------------------------
const resetIds = JSON.parse(await evalJs(`(async () => JSON.stringify((await window.pi.getInstances()).map(i => i.id)))()`));
if (resetIds[0]) await evalJs(`window.pi.newSession(${JSON.stringify(resetIds[0])})`);
await evalJs(`
  (() => {
    while (document.querySelector('.editor-tab .tab-close')) {
      document.querySelector('.editor-tab .tab-close').click();
    }
  })()
`);
await sleep(2500);
const itemsBefore = await modifiedItems();
check("fresh start has empty panel", itemsBefore.length === 0, itemsBefore.join(", "));

// ---------------------------------------------------------------------------
// 1. Run-scoped summary: first run creates hello.txt + edits greeting.ts.
//    Second run ONLY touches one new file; the settled summary must show only
//    that file, while the panel keeps the accumulated list.
// ---------------------------------------------------------------------------
await prompt('Create a file called hello.txt containing the text "hello" and a file called greeting.ts containing the text "hi"');
await sleep(1500);
await prompt('Create a file called run-two.txt containing the text "run two"');
await sleep(1500);
const text2 = await terminalText();
const summaryStart = text2.lastIndexOf("Session complete");
const summaryBlock = summaryStart >= 0 ? text2.slice(summaryStart) : "(no summary found)";
check("run-scoped summary lists only this run's file", summaryBlock.includes("run-two.txt") && !summaryBlock.includes("greeting.ts"), summaryBlock.split("\n").slice(0, 5).join(" | "));
const itemsAfterRun2 = await modifiedItems();
check("panel accumulates across runs", itemsAfterRun2.length === 3, itemsAfterRun2.join(", "));

// ---------------------------------------------------------------------------
// 2. File deletion: ask the agent to delete run-two.txt → tab should close.
// ---------------------------------------------------------------------------
await prompt('Delete the file run-two.txt');
await sleep(1500);
const tabsAfterDelete = await tabs();
check("deleted file tab closed", !tabsAfterDelete.includes("run-two.txt"), tabsAfterDelete.join(", "));
const itemsAfterDelete = await modifiedItems();
check("deleted file removed from panel", !itemsAfterDelete.some((i) => i.includes("run-two.txt")), itemsAfterDelete.join(", "));

// ---------------------------------------------------------------------------
// 3. New Session clears the panel
// ---------------------------------------------------------------------------
const activeId2 = await evalJs(`(async () => JSON.stringify((await window.pi.getInstances()).map(i => i.id)))()`);
const ids2 = JSON.parse(activeId2);
if (ids2[0]) await evalJs(`window.pi.newSession(${JSON.stringify(ids2[0])})`);
await sleep(1500);
const itemsAfterNewSession = await modifiedItems();
check("new session clears panel", itemsAfterNewSession.length === 0, itemsAfterNewSession.join(", "));

// ---------------------------------------------------------------------------
// 4. File in a NEW subdirectory under a symlinked root (/tmp) auto-opens
// ---------------------------------------------------------------------------
await prompt('Create a file at src/lib/util.js containing the text "export default 42;"');
await sleep(1500);
const tabsAfterSubdir = await tabs();
check("new-subdir file tab auto-opens", tabsAfterSubdir.includes("util.js"), tabsAfterSubdir.join(", "));

// ---------------------------------------------------------------------------
// 5. Clicking a bare filename in the terminal summary opens the editor
//    (via the link-provider path: simulate activate by calling openFileSmart
//    on the same path the link provider would produce).
// ---------------------------------------------------------------------------
const clicked = await evalJs(`
  (async () => {
    const item = [...document.querySelectorAll('#modified-list li')].find(li => li.textContent.includes('util.js'));
    if (!item) return 'no-item';
    item.click();
    await new Promise(r => setTimeout(r, 400));
    const active = document.querySelector('.editor-tab.active .tab-name')?.textContent;
    return active ?? 'none';
  })()
`);
check("click modified-file item opens editor", clicked === "util.js", String(clicked));

console.log("\n=== SUMMARY ===");
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
ws.close();
process.exit(failed.length ? 1 : 0);