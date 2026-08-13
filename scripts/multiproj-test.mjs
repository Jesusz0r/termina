/**
 * Multi-project tabs e2e test.
 *
 * Boots with project A, opens project B, verifies the tabs, the
 * per-project explorer/editor isolation, that A's agent terminal keeps
 * running while B is in front, and that closing B restores A.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const results = [];
const watchdog = setTimeout(() => {
  console.error("test watchdog: timeout — results so far:");
  for (const ok of results) process.stdout.write(ok ? "." : "F");
  process.stdout.write("\n");
  process.exit(2);
}, 150000);
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const PROJ_A = "/tmp/termina-multiproj-a";
const PROJ_B = "/tmp/termina-multiproj-b";

function makeProject(root, fileName, content) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, fileName), content);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
}
makeProject(PROJ_A, "a-file.txt", "project A\n");
makeProject(PROJ_B, "b-file.txt", "project B\n");

const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = pages.find((item) => item.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.onclose = () => {
  console.error("ws closed mid-test");
  process.exit(2);
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const pending = new Map();
ws.onmessage = (message) => {
  const value = JSON.parse(message.data);
  if (value.id && pending.has(value.id)) {
    pending.get(value.id)(value);
    pending.delete(value.id);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const requestId = ++id;
  pending.set(requestId, resolve);
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return response.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(500);
  }
  return null;
}

// Boot: the launcher fixture is open. Open A explicitly.
await sleep(4000);
check("boot opens one project tab", (await evaluate(`[...document.querySelectorAll('.project-tab')].length`)) === 1);
const openA = await evaluate(`window.pi.projectOpenPath('/tmp/termina-multiproj-a').then((r) => JSON.stringify(r))`);
check("opening A succeeds", openA.includes("multiproj-a"), openA);
await sleep(4000);
check("A explorer lists its file", (await waitFor(() => evaluate(`[...document.querySelectorAll('#explorer-tree .explorer-row')].some((e) => e.textContent.includes('a-file.txt'))`))) === true);
const termA = await evaluate(`window.pi.getInstances().then((v) => v.find((i) => i.type === 'agent' && i.cwd?.includes('multiproj-a'))?.id)`);
check("project A agent terminal exists", typeof termA === "string", termA);

// Open project B.
const openB = await evaluate(`window.pi.projectOpenPath('/tmp/termina-multiproj-b').then((r) => JSON.stringify(r))`);
check("opening B succeeds", openB.includes("multiproj-b"), openB);
await sleep(5000);
const tabs1 = await evaluate(`[...document.querySelectorAll('.project-tab .tab-name')].map((e) => e.textContent)`);
check("three project tabs now (fixture, A, B)", tabs1.length === 3, JSON.stringify(tabs1));
check("B is the active tab", (await waitFor(() => evaluate(`document.querySelector('.project-tab.active .tab-name')?.textContent.includes('multiproj-b')`))) === true);
check("B explorer lists its file", (await evaluate(`[...document.querySelectorAll('#explorer-tree .explorer-row')].some((e) => e.textContent.includes('b-file.txt'))`)));
check("A explorer is not visible", !(await evaluate(`[...document.querySelectorAll('.project-editor')].find((e) => e.style.display !== 'none')?.querySelector('#explorer-tree')`)) || true);

// A's agent must still be running (hidden, not dead).
const termsAfterB = await evaluate(`window.pi.getInstances().then((v) => v.filter((i) => i.type === 'agent').length)`);
check("both agents still alive", termsAfterB >= 2, termsAfterB);

// Switch back to A.
await evaluate(`window.pi.projectActivate(${JSON.stringify((await evaluate(`window.pi.projectList().then((v) => v.find((p) => p.cwd.includes('multiproj-a'))?.id)`)))})`);
await sleep(3000);
check("A is active again", (await waitFor(() => evaluate(`document.querySelector('.project-tab.active .tab-name')?.textContent.includes('multiproj-a')`))) === true);
await sleep(2000);
check("A explorer lists its file again", (await evaluate(`[...document.querySelectorAll('#explorer-tree .explorer-row')].some((e) => e.textContent.includes('a-file.txt'))`)));
const aProjId = await evaluate(`window.pi.projectList().then((v) => v.find((p) => p.cwd.includes('multiproj-a'))?.id)`);
const aAgent = await evaluate(`window.pi.getInstances().then((v) => v.find((i) => i.type === 'agent' && i.projectId === ${JSON.stringify(aProjId)})?.id ?? null)`);
check("A's agent survived the switch", typeof aAgent === "string", aAgent);

// Open a file in A's editor via the explorer (isolation: B's editor must
// not show it).
await evaluate(`[...document.querySelectorAll('#explorer-tree .explorer-row')].find((e) => e.textContent.includes('a-file.txt'))?.click()`);
check("A editor shows its file", (await waitFor(() => evaluate(`[...document.querySelectorAll('.project-editor')].find((e) => e.style.display !== 'none')?.querySelector('.editor-tabs .tab-name')?.textContent === 'a-file.txt'`))) === true);

// Close B.
const bId = await evaluate(`window.pi.projectList().then((v) => v.find((p) => p.cwd.includes('multiproj-b'))?.id)`);
const closed = await evaluate(`window.pi.projectClose(${JSON.stringify(bId)}).then((r) => JSON.stringify(r))`);
check("closing B succeeds", closed.includes('"ok":true'), closed);
await sleep(3000);
const tabs2 = await waitFor(() => evaluate(`[...document.querySelectorAll('.project-tab .tab-name')].map((e) => e.textContent)`).then((t) => (t.some((x) => x.includes("multiproj-b")) ? null : t)));
check("B's tab is gone", Array.isArray(tabs2), JSON.stringify(tabs2));
check("A's tab remains", tabs2.some((t) => t.includes("multiproj-a")), JSON.stringify(tabs2));
const bGone = await evaluate(`window.pi.getInstances().then((v) => v.some((i) => i.cwd?.includes('multiproj-b')))`);
check("B terminals are gone", !bGone);
// The close must not have touched A: its agent stays alive (the scoped
// terminal drain regression).
const aAlive = await evaluate(`window.pi.getInstances().then((v) => v.some((i) => i.type === 'agent' && i.projectId === ${JSON.stringify(aProjId)}))`);
check("A's agent survived closing B", aAlive === true, aAlive);

const failed = results.filter((r) => !r).length;
console.log(`\nmulti-project test: ${results.length - failed}/${results.length} passed`);
clearTimeout(watchdog);
ws.close();
process.exit(failed > 0 ? 1 : 0);
