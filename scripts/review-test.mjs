import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import { e2ePort } from "./e2e-port.mjs";
const projectRoot = process.env.TERMINA_INITIAL_CWD;
if (!projectRoot) throw new Error("TERMINA_INITIAL_CWD is required");
const greetingPath = join(projectRoot, "greeting.ts");
const getJson = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(JSON.parse(d))); res.on("error", reject); });
  req.on("error", reject);
});
const targets = await getJson(`http://127.0.0.1:${e2ePort()}/json`);
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
const owner = await evalJs(`window.pi.projectList().then((v) => { const p = v.find((x) => x.active); return p ? { projectId: p.id, workspaceId: p.workspaceId } : null; })`);
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); };

// 1. prompt the agent to edit greeting.ts
await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", { text: "Edit greeting.ts so the greeting is 'hi there'" });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
let seenWorking = false;
for (let i = 0; i < 150; i++) {
  await sleep(1000);
  const busy = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
  if (busy.includes('working')) seenWorking = true;
  if (seenWorking && !busy.includes('working')) break;
}
await sleep(1500);
const diskAfter = await evalJs(`window.pi.openFile(${JSON.stringify(greetingPath)}, ${JSON.stringify(owner)})`);
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
      diffText: document.getElementById('review-diff').textContent.replace(/\u00a0/g, " "),
      models: JSON.stringify(window.__reviewDebug ?? null),
    });
  })()
`));
check("review diff opens for the changed file", review.visible && review.filename.includes("greeting.ts"), JSON.stringify(review).slice(0, 150));
const models = JSON.parse(review.models ?? "{}");
const originalOk = (models.original ?? "").includes("hello") && !(models.original ?? "").includes("hi there");
const modifiedOk = (models.modified ?? "").includes("hi there");
check("diff shows original hello → modified hi there", originalOk && modifiedOk, JSON.stringify(models));

// 3. revert
await evalJs(`document.getElementById('review-revert').click()`);
await sleep(1000);
const afterRevert = await evalJs(`window.pi.openFile(${JSON.stringify(greetingPath)}, ${JSON.stringify(owner)})`);
check("revert restores the original content", afterRevert.content.includes('"hello"') && !afterRevert.content.includes("hi there"), JSON.stringify(afterRevert.content));
const mark = await evalJs(`JSON.stringify([...document.querySelectorAll('#modified-list li .review-mark')].map(m => m.textContent))`);
check("reverted marker shows", mark.includes("↩"), JSON.stringify(mark));

// 4. a deleted file remains reviewable and revert restores it
await evalJs(`document.getElementById('review-back').click()`);
await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
await send("Input.insertText", { text: "Delete greeting.ts" });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
seenWorking = false;
for (let i = 0; i < 150; i++) {
  await sleep(1000);
  const busy = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
  if (busy.includes("working")) seenWorking = true;
  if (seenWorking && !busy.includes("working")) break;
}
await sleep(1500);
await evalJs(`(() => [...document.querySelectorAll('#modified-list li')].find(li => li.querySelector('.path')?.textContent.includes('greeting.ts'))?.click())()`);
await sleep(1200);
const deletedReview = JSON.parse(await evalJs(`JSON.stringify({
  visible: document.getElementById('review-container').style.display !== 'none',
  hint: document.getElementById('review-hint').textContent,
  models: window.__reviewDebug,
  openDisabled: document.getElementById('review-open').disabled,
  revertDisabled: document.getElementById('review-revert').disabled,
})`));
check(
  "deleted file diff opens with baseline and empty current side",
  deletedReview.visible && deletedReview.hint.includes("deleted") && deletedReview.models.original.includes("hello") && deletedReview.models.modified === "" && deletedReview.openDisabled && !deletedReview.revertDisabled,
  JSON.stringify(deletedReview),
);
await evalJs(`document.getElementById('review-accept').click()`);
await sleep(300);
const acceptedDelete = await evalJs(`JSON.stringify({
  marks: [...document.querySelectorAll('#modified-list li .review-mark')].map((m) => m.textContent),
  current: null,
})`);
const stillDeleted = await evalJs(`window.pi.openFile(${JSON.stringify(greetingPath)}, ${JSON.stringify(owner)})`);
check("accept marks a deletion reviewed without restoring it", acceptedDelete.includes("✓") && stillDeleted.ok === false, `${acceptedDelete} ${JSON.stringify(stillDeleted)}`);
await evalJs(`(() => [...document.querySelectorAll('#modified-list li')].find(li => li.querySelector('.path')?.textContent.includes('greeting.ts'))?.click())()`);
await sleep(600);
await evalJs(`document.getElementById('review-revert').click()`);
await sleep(1000);
const restoredDelete = await evalJs(`window.pi.openFile(${JSON.stringify(greetingPath)}, ${JSON.stringify(owner)})`);
check("deleted file revert restores the baseline", restoredDelete.ok && restoredDelete.content.includes('"hello"'), JSON.stringify(restoredDelete));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
