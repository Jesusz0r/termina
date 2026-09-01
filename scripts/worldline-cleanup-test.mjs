/**
 * Phase 9 e2e: cleanup and lifecycle (WORLDLINES §10 worldline-cleanup-test).
 *
 * Expects Electron on TERMINA_E2E_PORT with:
 *   TERMINA_INITIAL_CWD=<Git repo: greeting.ts "hello">
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<worlds root pre-seeded by the launcher with:
 *     foreign-dir/  (no ownership marker — cleanup must refuse it)
 *     stale-cmp/    (marker + manifest with a dead pid — boot sweep removes
 *                    it)>
 *
 * Proves WORLDLINES §6.11:
 *   1. cancelling pair creation removes every app-owned resource
 *   2. closing one candidate terminal does not silently discard it
 *   3. discard leaves no process, directory, or pin behind
 *   4. stale cleanup refuses paths without the ownership marker
 *   5. the boot sweep removes marked stale resources
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { waitFor as waitUntil } from "./wait-for.mjs";
import { e2ePort } from "./e2e-port.mjs";

const port = e2ePort();
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
const getWorldlines = () => evalJs(`window.pi.projectList().then((projects) => window.pi.getWorldlines(projects.find((project) => project.active)?.id ?? ""))`);

const PROJ = process.env.TERMINA_INITIAL_CWD ?? "/tmp/termina-wline11-project";
const WORLDS = process.env.TERMINA_WORLDS_DIR ?? "/tmp/termina-wline11-worlds";

async function typePrompt(text) {
  await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
  await send("Input.insertText", { text });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

const waitFor = (predicate, timeoutMs = 120000) => waitUntil(predicate, timeoutMs, 1000);

// ------------------------------------------------- boot stale sweep ----
// The launcher seeded a marked stale comparison (dead pid) and a marker-less
// foreign dir. The boot sweep must remove the marked one and refuse the
// foreign one.
await sleep(3000);
check("the marked stale comparison is swept at boot", !existsSync(join(WORLDS, "stale-cmp")), "");
check("the marker-less foreign dir survives", existsSync(join(WORLDS, "foreign-dir")), "");
check("the foreign dir keeps its file", existsSync(join(WORLDS, "foreign-dir", "keep.txt")), "");

// ---------------------------------------------------------------- run 1 ----
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.find((r) => r.settledAt !== null && r.replayable === true) ?? null;
}, 300000);
check("a replayable run exists", run !== null, JSON.stringify(run?.id ?? null));
if (!run) process.exit(1);

// ----------------------------------------------------- cancel mid-creation ----
const fork = await evalJs(`window.pi.forkRun(${JSON.stringify(run.id)})`);
check("fork-run starts", fork?.ok === true, JSON.stringify(fork));
if (!fork?.ok) process.exit(1);
const comparisonId = fork.comparisonId;
const cancel = await evalJs(`window.pi.cancelWorldline(${JSON.stringify(comparisonId)})`);
check("cancelling pair creation removes the comparison", cancel?.ok === true, JSON.stringify(cancel));
await sleep(1500);
check("the comparison dir is gone", !existsSync(join(WORLDS, comparisonId)), "");
const left1 = await getWorldlines();
check("the worldline list is empty after cancel", (left1 ?? []).filter((w) => w.comparisonId === comparisonId).length === 0, JSON.stringify(left1));

// ------------------------------------------------- close without discard ----
const fork2 = await evalJs(`window.pi.forkRun(${JSON.stringify(run.id)})`);
check("second fork starts", fork2?.ok === true, JSON.stringify(fork2));
if (!fork2?.ok) process.exit(1);
const comparisonId2 = fork2.comparisonId;
const ready = await waitFor(async () => {
  const list = (await getWorldlines()) ?? [];
  const pair = list.filter((w) => w.comparisonId === comparisonId2);
  if (pair.length === 2 && pair.every((w) => w.state === "ready")) return { pair };
  return null;
}, 180000);
check("both candidates become ready", ready !== null, JSON.stringify(ready));
if (!ready) process.exit(1);
const a = ready.pair.find((w) => w.label === "A");

// Closing A's terminal must not silently discard the candidate.
const closed = await evalJs(`window.pi.closeTerminal(${JSON.stringify(a.terminalId)})`);
check("closing a candidate terminal ok", closed === undefined || closed === null, String(closed));
await sleep(1500);
const afterClose = await getWorldlines();
check("the candidate survives a terminal close", (afterClose ?? []).some((w) => w.comparisonId === comparisonId2 && w.label === "A"), JSON.stringify(afterClose?.map((w) => `${w.label}:${w.state}`)));
// Reopen it: the candidate session continues.
const reopened = await evalJs(`window.pi.openWorldlineTerminal(${JSON.stringify(comparisonId2)}, "A")`);
check("the candidate reopens", reopened?.ok === true, JSON.stringify(reopened));

// ---------------------------------------------------------- discard ----
const disc = await evalJs(`window.pi.discardWorldline(${JSON.stringify(comparisonId2)})`);
check("discard ok", disc?.ok === true, JSON.stringify(disc));
await sleep(2000);
check("the comparison dir is gone after discard", !existsSync(join(WORLDS, comparisonId2)), "");
const left2 = await getWorldlines();
check("the worldline list is empty after discard", (left2 ?? []).filter((w) => w.comparisonId === comparisonId2).length === 0, JSON.stringify(left2));

// No candidate processes survive: the candidate pids are gone.
const procs = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
const candidates = procs.filter((l) => l.includes(WORLDS));
check("no candidate processes survive discard", candidates.length === 0, candidates.slice(0, 2).join(" | "));

// Only the seeded foreign dir remains in the worlds root.
const remaining = readdirSync(WORLDS).filter((n) => n !== "promotion-journal");
check("only the foreign dir remains", remaining.length === 1 && remaining[0] === "foreign-dir", JSON.stringify(remaining));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
