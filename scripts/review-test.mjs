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

// 1. prompt the agent to edit greeting.ts
await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", { text: "Edit greeting.ts so the greeting is 'hi there'" });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
for (let i = 0; i < 150; i++) {
  await sleep(1000);
  const busy = await evalJs(`document.getElementById('status-state').textContent`);
  if (busy && !busy.includes('working') && i > 3) break;
}
await sleep(1500);
const diskAfter = await evalJs(`window.pi.openFile('/tmp/pi-editor-test-project/greeting.ts')`);
check("agent changed the file on disk", diskAfter.content.includes("hi there"), JSON.stringify(diskAfter.content));

// 2. the modified list has greeting.ts — click it → review diff opens
await evalJs(`
  (() => {
    const items = [...document.querySelectorAll('#modified-list li')];
    const item = items.find(li => li.querySelector('.path')?.textContent.includes('greeting.ts'));
    item?.click();
  })()
`);
await sleep(1200);
const review = JSON.parse(await evalJs(`
  (() => {
    const container = document.getElementById('review-container');
    return JSON.stringify({
      visible: container.style.display !== 'none',
      filename: document.getElementById('review-filename').textContent,
      hint: document.getElementById('review-hint').textContent,
      sides: [...document.querySelectorAll('#review-diff .original .view-lines, #review-diff .modified .view-lines')].map(el => el.textContent),
    });
  })()
`));
check("review diff opens for the changed file", review.visible && review.filename.includes("greeting.ts"), JSON.stringify(review).slice(0, 150));
const norm = review.sides.map(s => s.replace(/\u00a0/g, " "));
const hasHello = norm.some(s => s.includes("hello"));
const hasHiThere = norm.some(s => s.includes("hi there"));
const helloIdx = norm.findIndex(s => s.includes("hello"));
const hiIdx = norm.findIndex(s => s.includes("hi there"));
check("diff shows original hello → modified hi there", hasHello && hasHiThere && helloIdx !== -1 && hiIdx > helloIdx, JSON.stringify(norm).slice(0, 200));

// 3. revert
await evalJs(`document.getElementById('review-revert').click()`);
await sleep(1000);
const afterRevert = await evalJs(`window.pi.openFile('/tmp/pi-editor-test-project/greeting.ts')`);
check("revert restores the original content", afterRevert.content.includes('"hello"') && !afterRevert.content.includes("hi there"), JSON.stringify(afterRevert.content));
const mark = await evalJs(`JSON.stringify([...document.querySelectorAll('#modified-list li .review-mark')].map(m => m.textContent))`);
check("reverted marker shows", mark.includes("↩"), JSON.stringify(mark));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
