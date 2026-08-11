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

// 1. explorer rendered with the project root
const boot = JSON.parse(await evalJs(`
  (() => JSON.stringify({
    explorer: !!document.getElementById('explorer'),
    rootName: document.querySelector('#explorer-tree .explorer-row .explorer-name')?.textContent,
    rows: document.querySelectorAll('#explorer-tree .explorer-row').length,
  }))()
`));
check("explorer shows project root", boot.explorer && boot.rootName === "termina-test-project", JSON.stringify(boot));

// 2. root is expanded by default → see files + src dir
await sleep(300);
const rootChildren = JSON.parse(await evalJs(`
  (() => JSON.stringify([...document.querySelectorAll('#explorer-tree .explorer-children .explorer-row .explorer-name')].map(n => n.textContent)))()
`));
check("root lists files", rootChildren.includes("greeting.ts") && rootChildren.includes("hello.txt") && rootChildren.includes("src"), rootChildren.join(", "));

// 3. create a file via the API
const created = await evalJs(`(async () => JSON.stringify(await window.pi.createEntry('manual-new.txt', 'file')))()`);
await sleep(600);
const hasNew = JSON.parse(await evalJs(`(async () => JSON.stringify(await window.pi.listDir('/tmp/termina-test-project')))()`)).entries.some(e => e.name === "manual-new.txt");
check("create file works", created.includes('"ok":true') && hasNew);

// 4. rename it
const renamed = await evalJs(`(async () => JSON.stringify(await window.pi.renameEntry('manual-new.txt', 'renamed.txt')))()`);
const hasRenamed = JSON.parse(await evalJs(`(async () => JSON.stringify(await window.pi.listDir('/tmp/termina-test-project')))()`)).entries.some(e => e.name === "renamed.txt");
check("rename works", renamed.includes('"ok":true') && hasRenamed);

// 5. delete it
const deleted = await evalJs(`(async () => JSON.stringify(await window.pi.deleteEntry('renamed.txt')))()`);
const stillThere = JSON.parse(await evalJs(`(async () => JSON.stringify(await window.pi.listDir('/tmp/termina-test-project')))()`)).entries.some(e => e.name === "renamed.txt");
check("delete works", deleted.includes('"ok":true') && !stillThere);

// 6. create a folder + file inside it
await evalJs(`(async () => window.pi.createEntry('my-folder', 'dir'))()`);
await evalJs(`(async () => window.pi.createEntry('my-folder/inner.txt', 'file'))()`);
await sleep(600);
const inner = JSON.parse(await evalJs(`(async () => JSON.stringify(await window.pi.listDir('/tmp/termina-test-project/my-folder')))()`)).entries;
check("create folder + nested file works", inner.length === 1 && inner[0].name === "inner.txt");

// 7. clicking a file row opens it in the editor (root is expanded by default)
await evalJs(`
  (() => {
    const rows = [...document.querySelectorAll('#explorer-tree .explorer-children .explorer-row')];
    const hello = rows.find(r => r.querySelector('.explorer-name')?.textContent === 'hello.txt');
    hello?.click();
  })()
`);
await sleep(800);
const tabs = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('.editor-tab .tab-name')].map(t => t.textContent))`));
check("clicking a file opens it in the editor", tabs.includes("hello.txt"), tabs.join(", "));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
