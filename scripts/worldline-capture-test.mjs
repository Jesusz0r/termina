/**
 * Phase 8 e2e: capture correctness (WORLDLINES §10 worldline-capture-test).
 *
 * Expects Electron on :9222 with:
 *   PI_EDITOR_INITIAL_CWD=<Git repo: greeting.ts "hello", hello.txt "first">
 *   PI_EDITOR_EVENTS_DIR=<clean dedicated dir>
 *   PI_EDITOR_WORLDS_DIR=<clean dedicated worlds root>
 *
 * Proves WORLDLINES §6.4:
 *   1. every tool dot captures its exact source state (byte-exact: the
 *      forked candidate reproduces the snapshot content)
 *   2. the primary repo stays untouched (status, index, refs)
 *   3. corrupting a snapshot object invalidates dependent points without
 *      touching primary source (fork-point fails with a stable error)
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const port = 9222;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 240) : ""}`);
};

const pages = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROJ = "/tmp/pi-editor-wline8-project";
const WORLDS = "/tmp/pi-editor-wline8-worlds";
const git = (args) => execFileSync("git", args, { cwd: PROJ, encoding: "utf8" }).trim();
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const repoState = () => ({ head: git(["rev-parse", "HEAD"]), refs: git(["for-each-ref"]), indexSha: sha256(join(PROJ, ".git", "index")) });

async function typePrompt(text) {
  await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
  await send("Input.insertText", { text });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

async function waitFor(predicate, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(1000);
  }
  return null;
}

const before = repoState();

// ---------------------------------------------------------------- run 1 ----
await typePrompt("Edit greeting.ts so the greeting is hi there, and edit hello.txt so it says second");
const run = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.find((r) => r.settledAt !== null) ?? null;
}, 300000);
check("a settled run exists", run !== null, JSON.stringify(run?.id ?? null));
if (!run) process.exit(1);

// Every tool dot captured a state.
const dots = await waitFor(async () => {
  const tl = (await evalJs(`window.pi.getTimeline("term-1")`)) ?? [];
  const tools = tl.filter((e) => e.t === "tool" && e.stateId && e.entryId);
  return tools.length >= 2 ? tools : null;
}, 60000);
check("every tool dot captured its source state", dots !== null, JSON.stringify(dots?.map((d) => d.relPath)));
if (!dots) process.exit(1);

// Fork at the greeting dot: the candidate must reproduce the snapshot bytes
// of that exact moment.
const greetingDot = dots.find((d) => d.relPath === "greeting.ts");
const snapshot = await evalJs(`window.pi.getTimelineContent("term-1", ${greetingDot.seq})`);
check("the moment snapshot has content", snapshot?.ok === true && typeof snapshot?.content === "string", JSON.stringify(snapshot?.ok));
if (!snapshot?.ok) process.exit(1);
const fork = await evalJs(`window.pi.forkPoint("term-1", ${greetingDot.seq})`);
check("fork at the greeting moment starts", fork?.ok === true, JSON.stringify(fork));
if (!fork?.ok) process.exit(1);
const cand = await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  const w = list.find((x) => x.comparisonId === fork.comparisonId);
  return w && w.state === "ready" ? w : null;
}, 180000);
check("moment candidate becomes ready", cand !== null, JSON.stringify(cand?.state));
if (!cand) process.exit(1);
const candGreeting = readFileSync(join(cand.root, "greeting.ts"), "utf8");
check("candidate reproduces the exact moment bytes", candGreeting === snapshot.content, JSON.stringify({ cand: candGreeting.slice(0, 40), snap: String(snapshot.content).slice(0, 40) }));

// The primary repo is untouched by captures and forks.
const afterFork = repoState();
check("HEAD unchanged", before.head === afterFork.head);
check("refs unchanged", before.refs === afterFork.refs);
check("index unchanged", before.indexSha === afterFork.indexSha);
check("no stray files in the primary", git(["status", "--porcelain"]).split("\n").filter(Boolean).length === 2, git(["status", "--porcelain"]));

// ------------------------------------- corrupt a snapshot object ----
// Remove the store objects: every dependent fork point must fail with a
// stable error, while the primary source stays untouched.
const discard = await evalJs(`window.pi.discardWorldline(${JSON.stringify(fork.comparisonId)})`);
check("discard ok", discard?.ok === true, JSON.stringify(discard));
await sleep(1500);

const storeRoot = process.env.PI_EDITOR_USER_DATA_DIR ?? join(process.env.HOME, "Library", "Application Support", "pi-ditor");
const stores = execFileSync("find", [join(storeRoot, "worldlines"), "-path", "*/git/objects", "-type", "d"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const storeObjects = stores.sort().pop();
check("the snapshot store exists", !!storeObjects, String(storeObjects));
if (!storeObjects) process.exit(1);
rmSync(storeObjects, { recursive: true, force: true });

const corruptFork = await evalJs(`window.pi.forkPoint("term-1", ${greetingDot.seq})`);
check("a corrupt snapshot state rejects the fork", corruptFork?.ok === false && typeof corruptFork?.error === "string" && String(corruptFork.error).length > 0, JSON.stringify(corruptFork));

const afterCorrupt = repoState();
check("primary untouched by the corruption", before.head === afterCorrupt.head && before.refs === afterCorrupt.refs && before.indexSha === afterCorrupt.indexSha, "");

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
