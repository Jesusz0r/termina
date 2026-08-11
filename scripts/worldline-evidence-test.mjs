/**
 * Phase 9 e2e: evidence contract (WORLDLINES §10 worldline-evidence-test).
 *
 * Expects Electron on :9222 with:
 *   TERMINA_INITIAL_CWD=<Git repo: greeting.ts "hello", package.json with
 *     a test script that requires "hi there", a .pi/settings.json>
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<clean dedicated worlds root>
 *
 * Proves WORLDLINES §6.8:
 *   1. the base Verify command runs for both candidates
 *   2. a candidate's changed test config is shown but never replaces the
 *      required base check
 *   3. a candidate run invalidates the evidence (stale), and a re-run
 *      refreshes it
 *   4. explicit manual promotion proceeds without an evidence winner
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

const PROJ = "/tmp/termina-wline9-project";
const WORLDS = "/tmp/termina-wline9-worlds";
const git = (args) => execFileSync("git", args, { cwd: PROJ, encoding: "utf8" }).trim();
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const repoState = () => ({ head: git(["rev-parse", "HEAD"]), refs: git(["for-each-ref"]), indexSha: sha256(join(PROJ, ".git", "index")) });

async function typePrompt(text, tabIndex = 0) {
  if (tabIndex > 0) {
    await evalJs(`document.querySelectorAll('.terminal-tab')[${tabIndex}]?.click()`);
    await sleep(400);
  }
  await evalJs(`document.querySelector('.term-pane.active .xterm-helper-textarea')?.focus()`);
  await sleep(150);
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

await evalJs(`window.__lastEvidence = null; window.pi.onEvidenceUpdate((s) => { window.__lastEvidence = s; });`);
const before = repoState();

// ---------------------------------------------------------------- run 1 ----
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.find((r) => r.settledAt !== null && r.replayable === true) ?? null;
}, 300000);
check("a replayable run exists", run !== null, JSON.stringify(run?.id ?? null));
if (!run) process.exit(1);

const fork = await evalJs(`window.pi.forkRun(${JSON.stringify(run.id)})`);
check("fork-run starts", fork?.ok === true, JSON.stringify(fork));
if (!fork?.ok) process.exit(1);
const comparisonId = fork.comparisonId;
const ready = await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  const pair = list.filter((w) => w.comparisonId === comparisonId);
  if (pair.length === 2 && pair.every((w) => w.state === "ready")) return { pair };
  return null;
}, 180000);
check("both candidates become ready", ready !== null, JSON.stringify(ready));
if (!ready) process.exit(1);
const a = ready.pair.find((w) => w.label === "A");
const b = ready.pair.find((w) => w.label === "B");

// ------------------------------------------- the base Verify command ----
const ev = await evalJs(`window.pi.runEvidence(${JSON.stringify(comparisonId)})`);
check("evidence run starts", ev?.ok === true, JSON.stringify(ev));
const summary = await waitFor(async () => {
  const s = await evalJs(`window.__lastEvidence`);
  return s && s.comparisonId === comparisonId ? s : null;
}, 120000);
check("evidence summary arrives", summary !== null, JSON.stringify(summary?.error));
if (!summary) process.exit(1);
const verifyA = summary.byCandidate.A.find((r) => r.kind === "verify");
const verifyB = summary.byCandidate.B.find((r) => r.kind === "verify");
// A (the settled reference) passes; B is the untouched start and may
// legitimately fail the test. Both must run the resolved base command
// (the record stores the display label).
check(
  "the base Verify command runs for both candidates",
  verifyA?.status === "pass" && String(verifyA?.result.command ?? "") === "npm run test" && String(verifyB?.result.command ?? "") === "npm run test",
  JSON.stringify({ A: { status: verifyA?.status, cmd: verifyA?.result.command }, B: { status: verifyB?.status, cmd: verifyB?.result.command } }),
);

// ------------------- a changed test config is shown, never replaces the base ----
// The candidate's own package.json changes the test script; the evidence
// must still run the base command and report the change.
const aRoot = a.root;
writeFileSync(join(aRoot, "package.json"), readFileSync(join(aRoot, "package.json"), "utf8").replace('"test": "node test.js"', '"test": "node other-test.js"'));
await sleep(800);
await evalJs(`window.__lastEvidence = null;`);
const ev2 = await evalJs(`window.pi.runEvidence(${JSON.stringify(comparisonId)})`);
check("evidence re-runs after the config change", ev2?.ok === true, JSON.stringify(ev2));
const summary2 = await waitFor(async () => {
  const s = await evalJs(`window.__lastEvidence`);
  return s && s.comparisonId === comparisonId && s.ts !== summary.ts ? s : null;
}, 120000);
const depsA = summary2?.byCandidate.A.find((r) => r.kind === "dependencies");
check("the changed test config is reported", depsA?.result?.testScriptChanged === true, JSON.stringify(depsA?.result));
const verifyA2 = summary2?.byCandidate.A.find((r) => r.kind === "verify");
// A's own test script was changed to a broken one; the verify still passes
// because the evidence runs the resolved BASE body, not the alias.
check("the base command still runs", verifyA2?.status === "pass" && String(verifyA2?.result.command ?? "") === "npm run test", JSON.stringify({ status: verifyA2?.status, cmd: verifyA2?.result.command }));
// Restore the candidate's package.json for the later steps.
writeFileSync(join(aRoot, "package.json"), readFileSync(join(aRoot, "package.json"), "utf8").replace('"test": "node other-test.js"', '"test": "node test.js"'));

// -------------------------------------------- a candidate run invalidates evidence ----
await typePrompt("Edit hello.txt so it says second", 1); // into candidate A's terminal
const staleSummary = await waitFor(async () => {
  const s = await evalJs(`window.__lastEvidence`);
  return s && s.comparisonId === comparisonId && s.stale === true ? s : null;
}, 300000);
check("a candidate run marks the evidence stale", staleSummary !== null, JSON.stringify(staleSummary?.stale));
// Wait for the candidate run before starting evidence. A file change can
// invalidate evidence before the bridge reports agent_start.
const candidateSettled = await waitFor(async () => {
  const insts = (await evalJs(`window.pi.getInstances()`)) ?? [];
  const aInst = insts.find((i) => i.id === a.terminalId);
  const timeline = (await evalJs(`window.pi.getTimeline(${JSON.stringify(a.terminalId)})`)) ?? [];
  const started = timeline.some((event) => event.t === "agent_start");
  const settled = timeline.some((event) => event.t === "agent_settled");
  return aInst && !aInst.busy && started && settled ? aInst : null;
}, 120000);
check("the candidate run settles before evidence", candidateSettled !== null, JSON.stringify(candidateSettled));
if (!candidateSettled) process.exit(1);
await sleep(1500);

// A fresh run refreshes it.
const ev3 = await evalJs(`window.pi.runEvidence(${JSON.stringify(comparisonId)})`);
check("evidence re-runs after the candidate run", ev3?.ok === true, JSON.stringify(ev3));
const summary3 = await waitFor(async () => {
  const s = await evalJs(`window.__lastEvidence`);
  return s && s.comparisonId === comparisonId && s.stale === false && s.ts !== summary2?.ts ? s : null;
}, 120000);
check("the refreshed evidence is current", summary3 !== null && summary3?.stale === false, JSON.stringify(summary3?.stale));

await sleep(1500);

// --------------------- manual promotion with current evidence ----
// With current passing evidence the promotion proceeds without an
// evidence-winner label (WORLDLINES §6.10).
const promote = await evalJs(`window.pi.promoteWorldline(${JSON.stringify(comparisonId)}, "A")`);
check("promotion proceeds with current evidence", promote?.ok === true, JSON.stringify(promote));
check("promotion applied the source", readFileSync(join(PROJ, "greeting.ts"), "utf8").includes("hi there"), readFileSync(join(PROJ, "greeting.ts"), "utf8").slice(0, 40));

const after = repoState();
check("primary git metadata untouched", before.head === after.head && before.refs === after.refs && before.indexSha === after.indexSha, "");

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
