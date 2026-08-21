/**
 * Phase 7 e2e: Challenge Mode.
 *
 * Expects Electron on :9222 with:
 *   TERMINA_INITIAL_CWD=<Git repo: greeting.ts "hello", package.json with
 *     a test script that requires "hi there">
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<clean dedicated worlds root>
 *
 * Proves the Release 3 gate (WORLDLINES §7): one click launches the
 * challenger (B replays the original task automatically) and Termina ranks
 * only current measured evidence without a model judging another model.
 *   1. a completed run challenges: B auto-submits the task and settles
 *   2. evidence runs for both candidates serially: verify passes on both
 *   3. the fixed profiles produce deterministic verdicts with exact reasons
 *   4. Mine-path changes make a candidate ineligible with the reason
 *   5. the verdict chips and evidence lines render in the panel
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor as waitUntil } from "./wait-for.mjs";

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

const PROJ = process.env.TERMINA_INITIAL_CWD ?? "/tmp/termina-wline6-project";
const WORLDS = process.env.TERMINA_WORLDS_DIR ?? "/tmp/termina-wline6-worlds";
const git = (args) => execFileSync("git", args, { cwd: PROJ, encoding: "utf8" }).trim();
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const repoState = () => ({ head: git(["rev-parse", "HEAD"]), refs: git(["for-each-ref"]), indexSha: sha256(join(PROJ, ".git", "index")) });

async function typePrompt(text) {
  await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
  await send("Input.insertText", { text });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

const waitFor = (predicate, timeoutMs = 120000) => waitUntil(predicate, timeoutMs, 1000);

// The renderer stores the latest evidence summary for the test.
await evalJs(`window.__lastEvidence = null; window.pi.onEvidenceUpdate((s) => { window.__lastEvidence = s; });`);

// ---------------------------------------------------------------- run 1 ----
const before = repoState();
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.find((r) => r.settledAt !== null && r.replayable === true) ?? null;
}, 240000);
check("a replayable run exists", run !== null, JSON.stringify(run?.id ?? null));
if (!run) process.exit(1);

// -------------------------------------------------------------- challenge ----
const chal = await evalJs(`window.pi.challengeRun(${JSON.stringify(run.id)})`);
check("challenge launches", chal?.ok === true, JSON.stringify(chal));
if (!chal?.ok) process.exit(1);
const comparisonId = chal.comparisonId;

// B auto-submits the original task, works, and settles (its terminal stays
// open, so the busy flag is the completion signal).
const settled = await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  if (list.some((w) => w.comparisonId === comparisonId && w.state === "error")) {
    return { error: list.find((w) => w.comparisonId === comparisonId && w.state === "error")?.error ?? "error" };
  }
  const b = list.find((w) => w.comparisonId === comparisonId && w.label === "B");
  const a = list.find((w) => w.comparisonId === comparisonId && w.label === "A");
  if (!a || !b || !b.terminalId) return null;
  const insts = (await evalJs(`window.pi.getInstances()`)) ?? [];
  const bInst = insts.find((i) => i.id === b.terminalId);
  if (!bInst) return null;
  // The challenger started (was busy) and finished (idle again).
  if (!bInst.busy && readFileSync(join(b.root, "greeting.ts"), "utf8").includes("hi there")) return { a, b };
  return null;
}, 300000);
check("the challenger B settled on its own", settled !== null && !("error" in settled), JSON.stringify(settled));
if (!settled || "error" in settled) process.exit(1);
check("B solved the task", readFileSync(join(settled.b.root, "greeting.ts"), "utf8").includes("hi there"), readFileSync(join(settled.b.root, "greeting.ts"), "utf8").slice(0, 40));

// ---------------------------------------------------------------- evidence ----
const t0 = Date.now();
const ev = await evalJs(`window.pi.runEvidence(${JSON.stringify(comparisonId)})`);
check("evidence run starts", ev?.ok === true, JSON.stringify(ev));
const summary = await waitFor(async () => {
  const s = await evalJs(`window.__lastEvidence`);
  return s && s.comparisonId === comparisonId ? s : null;
}, 120000);
check("evidence summary arrives", summary !== null, `after ${(Date.now() - t0) / 1000}s ` + JSON.stringify(summary?.error));
if (!summary) process.exit(1);

const verifyA = summary.byCandidate.A.find((r) => r.kind === "verify");
const verifyB = summary.byCandidate.B.find((r) => r.kind === "verify");
check("verify passes on both candidates", verifyA?.status === "pass" && verifyB?.status === "pass", JSON.stringify({ A: verifyA?.status, B: verifyB?.status, reasonA: verifyA?.reason, reasonB: verifyB?.reason }));

const few = summary.profiles.find((p) => p.profile === "fewer-dependencies");
check("fewer-dependencies verdict is a tie (both zero added)", few?.winner === "tie", JSON.stringify(few));
const api = summary.profiles.find((p) => p.profile === "preserve-api");
check("preserve-api is unavailable (no public roots)", api?.winner === "unavailable" && String(api?.reason).includes("public exports"), JSON.stringify(api));
const perf = summary.profiles.find((p) => p.profile === "performance-first");
check("performance-first is unavailable (no harness)", perf?.winner === "unavailable" && String(perf?.reason).includes("benchmark"), JSON.stringify(perf));
const foot = summary.profiles.find((p) => p.profile === "simpler-implementation");
check("footprint verdict is a tie (both one file, one line)", foot?.winner === "tie", JSON.stringify(foot));

// The DOM renders the verdict chips and the evidence lines.
const dom = await waitFor(async () => {
  const d = await evalJs(
    `(() => {
      const pair = [...document.querySelectorAll('.comparison')].find((x) => x.dataset.cmp === ${JSON.stringify(comparisonId)});
      if (!pair) return null;
      return {
        chips: pair.querySelectorAll('.cmp-verdicts .verdict').length,
        winner: pair.querySelector('.evidence-winner')?.textContent ?? null,
      };
    })()`,
  );
  return d && d.chips >= 4 ? d : null;
}, 15000);
check("verdict chips render in the panel", dom !== null, JSON.stringify(dom));

// -------------------------------------------------- mine ineligibility ----
await evalJs(`window.pi.setMineFile(${JSON.stringify(join(PROJ, "greeting.ts"))}, true)`);
await sleep(500);
await evalJs(`window.__lastEvidence = null;`);
const ev2 = await evalJs(`window.pi.runEvidence(${JSON.stringify(comparisonId)})`);
check("evidence re-runs", ev2?.ok === true, JSON.stringify(ev2));
const summary2 = await waitFor(async () => {
  const s = await evalJs(`window.__lastEvidence`);
  return s && s.comparisonId === comparisonId && s.ts !== summary.ts ? s : null;
}, 120000);
const mineElig = summary2?.profiles.find((p) => p.profile === "fewer-dependencies")?.eligibility?.A ?? "";
check("a Mine change makes the candidate ineligible", typeof mineElig === "string" && mineElig.includes("you own"), JSON.stringify(mineElig));
await evalJs(`window.pi.setMineFile(${JSON.stringify(join(PROJ, "greeting.ts"))}, false)`);

// ------------------------------------------------- primary stays clean ----
const after = repoState();
check("HEAD unchanged", before.head === after.head);
check("refs unchanged", before.refs === after.refs);
check("index unchanged", before.indexSha === after.indexSha);

// --------------------------------------------------------------- discard ----
const disc = await evalJs(`window.pi.discardWorldline(${JSON.stringify(comparisonId)})`);
check("discard ok", disc?.ok === true, JSON.stringify(disc));
await sleep(1500);
const left = await evalJs(`window.pi.getWorldlines()`);
check("no candidates remain", (left ?? []).filter((w) => w.comparisonId === comparisonId).length === 0, JSON.stringify(left));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
