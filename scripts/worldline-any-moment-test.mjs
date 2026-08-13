/**
 * Phase 6 e2e: Fork Any Moment.
 *
 * Expects Electron on :9222 with:
 *   TERMINA_INITIAL_CWD=<Git repo: greeting.ts "hello", hello.txt "first">
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<clean dedicated worlds root>
 *
 * Proves the Release 2 gate (WORLDLINES §7): every visible tool dot becomes
 * a forkable moment with that exact captured source state and the persisted
 * Pi context of the moment.
 *   1. run 1 edits greeting.ts; its tool dot gains a captured state
 *   2. run 2 edits hello.txt; its tool dot gains a captured state
 *   3. forking at run 1's dot reproduces the source AT THAT MOMENT (the
 *      hello.txt edit stays out) and the session branches exclude the
 *      later context
 *   4. forking at run 2's dot includes the earlier greeting change
 *   5. the recorder state label shows ready; dots render forkable
 *   6. a candidate terminal rejects nested forking
 *   7. discard removes both moment candidates
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

const PROJ = process.env.TERMINA_INITIAL_CWD ?? "/tmp/termina-wline5-project";
const WORLDS = process.env.TERMINA_WORLDS_DIR ?? "/tmp/termina-wline5-worlds";
const git = (args) => execFileSync("git", args, { cwd: PROJ, encoding: "utf8" }).trim();

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

/** The tool dot for a path whose moment captured (stateId + entryId). */
async function forkableDotFor(relPath) {
  const tl = (await evalJs(`window.pi.getTimeline("term-1")`)) ?? [];
  const dots = tl.filter((e) => e.t === "tool" && e.relPath === relPath && e.stateId && e.entryId);
  return dots.length ? dots[0] : null;
}

// ---------------------------------------------------------------- run 1 ----
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run1 = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.filter((r) => r.settledAt !== null).at(-1) ?? null;
}, 240000);
check("run 1 settled", run1 !== null, JSON.stringify(run1?.id ?? null));
const dot1 = await waitFor(async () => forkableDotFor("greeting.ts"), 30000);
check("greeting dot captured its moment state", dot1 !== null, JSON.stringify(dot1 ? { seq: dot1.seq, stateId: dot1.stateId?.slice(0, 8) } : null));

// The dot renders forkable and the recorder is ready (label hidden).
const domState = await waitFor(async () => {
  const d = await evalJs(
    `(() => { const dot = [...document.querySelectorAll('#timeline-dots .timeline-dot')].find((x) => x.title.includes('greeting.ts')); const rec = document.getElementById('timeline-recorder'); return { forkable: dot?.classList.contains('forkable') ?? false, recHidden: rec.hidden }; })()`,
  );
  return d && d.forkable && d.recHidden ? d : null;
}, 15000);
check("dot renders forkable and recorder is ready", domState !== null, JSON.stringify(domState));

// ---------------------------------------------------------------- run 2 ----
await typePrompt("Edit hello.txt so it says second");
const run2 = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  const r = runs.filter((x) => x.settledAt !== null).at(-1);
  return r && r.id !== run1.id ? r : null;
}, 240000);
check("run 2 settled", run2 !== null, JSON.stringify(run2?.id ?? null));
const dot2 = await waitFor(async () => forkableDotFor("hello.txt"), 30000);
check("hello dot captured its moment state", dot2 !== null, JSON.stringify(dot2 ? { seq: dot2.seq, stateId: dot2.stateId?.slice(0, 8) } : null));

// -------------------------------------------- fork at run 1's moment ----
const fork1 = await evalJs(`window.pi.forkPoint("term-1", ${dot1.seq})`);
check("fork at the greeting moment starts", fork1?.ok === true, JSON.stringify(fork1));
if (!fork1?.ok) process.exit(1);
const cmp1 = fork1.comparisonId;
const moment1 = await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  const w = list.find((x) => x.comparisonId === cmp1 && x.role === "moment");
  return w && w.state === "ready" ? w : null;
}, 180000);
check("moment candidate becomes ready", moment1 !== null, JSON.stringify(moment1?.state));
if (!moment1) process.exit(1);
check("greeting matches the moment", readFileSync(join(moment1.root, "greeting.ts"), "utf8").includes("hi there"), readFileSync(join(moment1.root, "greeting.ts"), "utf8").slice(0, 40));
check("the later hello.txt edit stays out", readFileSync(join(moment1.root, "hello.txt"), "utf8").includes("first"), readFileSync(join(moment1.root, "hello.txt"), "utf8").slice(0, 40));
if (moment1.sessionFile) {
  const session = readFileSync(moment1.sessionFile, "utf8");
  check("the session branches before the later edit", !session.includes("second"), "later context excluded");
}

// ---------------------------------------------- fork at run 2's moment ----
const fork2 = await evalJs(`window.pi.forkPoint("term-1", ${dot2.seq})`);
check("fork at the hello moment starts", fork2?.ok === true, JSON.stringify(fork2));
if (!fork2?.ok) process.exit(1);
const cmp2 = fork2.comparisonId;
const moment2 = await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  const w = list.find((x) => x.comparisonId === cmp2 && x.role === "moment");
  return w && w.state === "ready" ? w : null;
}, 180000);
check("second moment candidate becomes ready", moment2 !== null, JSON.stringify(moment2?.state));
if (!moment2) process.exit(1);
check("second moment includes the earlier edit", readFileSync(join(moment2.root, "greeting.ts"), "utf8").includes("hi there"), readFileSync(join(moment2.root, "greeting.ts"), "utf8").slice(0, 40));
check("second moment has its own edit", readFileSync(join(moment2.root, "hello.txt"), "utf8").includes("second"), readFileSync(join(moment2.root, "hello.txt"), "utf8").slice(0, 40));

// A candidate terminal with no recorded moments has nothing to fork; the
// full nested flow (moments inside candidates) is covered by the isolation
// suite.
const nested = await evalJs(`window.pi.forkPoint(${JSON.stringify(moment1.terminalId)}, 1)`);
check("a candidate terminal with no moments has no forkable dots", nested?.ok === false && String(nested?.error ?? "").includes("moment"), JSON.stringify(nested));

// ------------------------------------------------------------ cleanup ----
const d1 = await evalJs(`window.pi.discardWorldline(${JSON.stringify(cmp1)})`);
const d2 = await evalJs(`window.pi.discardWorldline(${JSON.stringify(cmp2)})`);
check("discards ok", d1?.ok === true && d2?.ok === true, JSON.stringify({ d1, d2 }));
await sleep(1500);
const left = await evalJs(`window.pi.getWorldlines()`);
check("no moment candidates remain", (left ?? []).filter((w) => w.role === "moment").length === 0, JSON.stringify(left));

// The primary repo is untouched (only the two agent runs' edits).
check("primary is a clean repo of the two edits", git(["status", "--porcelain"]).split("\n").filter(Boolean).length === 2, git(["status", "--porcelain"]));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
