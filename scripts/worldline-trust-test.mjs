/**
 * Phase 9 e2e: trust handling (WORLDLINES §10 worldline-trust-test).
 *
 * Expects Electron on :9222 with:
 *   TERMINA_INITIAL_CWD=<Git repo: greeting.ts "hello", .pi/settings.json>
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<clean dedicated worlds root>
 *
 * Proves WORLDLINES §6.7:
 *   1. a run forks while its trust-sensitive resources match
 *   2. a changed trust-sensitive project resource rejects the fork with
 *      the exact reason
 *   3. candidate paths never land in the user's trust.json
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

const PROJ = process.env.TERMINA_INITIAL_CWD ?? "/tmp/termina-wline10-project";
const WORLDS = process.env.TERMINA_WORLDS_DIR ?? "/tmp/termina-wline10-worlds";
const trustJson = join(homedir(), ".pi", "agent", "trust.json");
const readTrust = () => {
  try {
    return readFileSync(trustJson, "utf8");
  } catch {
    return "";
  }
};
const trustBefore = readTrust();

async function typePrompt(text) {
  await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
  await send("Input.insertText", { text });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

const waitFor = (predicate, timeoutMs = 120000) => waitUntil(predicate, timeoutMs, 1000);

// ---------------------------------------------------------------- run 1 ----
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.find((r) => r.settledAt !== null) ?? null;
}, 300000);
check("a settled run exists", run !== null, JSON.stringify(run?.id ?? null));
if (!run) process.exit(1);

// The trust-sensitive resources match: the fork succeeds.
const fork1 = await evalJs(`window.pi.forkRun(${JSON.stringify(run.id)})`);
check("a run with matching trust resources forks", fork1?.ok === true, JSON.stringify(fork1));
if (!fork1?.ok) process.exit(1);
const comparisonId = fork1.comparisonId;

// The candidates become ready without writing their paths to trust.json.
const ready = await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  const pair = list.filter((w) => w.comparisonId === comparisonId);
  if (pair.length === 2 && pair.every((w) => w.state === "ready")) return { pair };
  return null;
}, 180000);
check("both candidates become ready", ready !== null, JSON.stringify(ready));
if (!ready) process.exit(1);

// A changed trust-sensitive project resource rejects the fork. The first
// pair still occupies the budget: discard it first.
await evalJs(`window.pi.discardWorldline(${JSON.stringify(comparisonId)})`);
await sleep(1500);
writeFileSync(join(PROJ, ".pi", "settings.json"), '{"theme": "light"}\n');
await sleep(1200);
const fork2 = await evalJs(`window.pi.forkRun(${JSON.stringify(run.id)})`);
check("changed trust resources reject the fork", fork2?.ok === false && String(fork2?.error ?? "").includes("trust-sensitive resources changed"), JSON.stringify(fork2));

// Restore: the fork works again.
writeFileSync(join(PROJ, ".pi", "settings.json"), '{"theme":"dark"}\n');
await sleep(1200);
const fork3 = await evalJs(`window.pi.forkRun(${JSON.stringify(run.id)})`);
check("restored trust resources fork again", fork3?.ok === true, JSON.stringify(fork3));
if (!fork3?.ok) process.exit(1);
const cmp3 = fork3.comparisonId;
await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  const pair = list.filter((w) => w.comparisonId === cmp3);
  return pair.length === 2 && pair.every((w) => w.state === "ready") ? true : null;
}, 180000);

// Candidate paths never land in the user's trust.json (WORLDLINES §6.7).
const trustAfter = readTrust();
check("no candidate paths in the user trust store", !trustAfter.includes(WORLDS) && !trustAfter.includes("/cmp-"), `before=${trustBefore.length}B after=${trustAfter.length}B`);

// The run records its trust decision.
const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
const recorded = runs.find((r) => r.id === run.id);
check("the run records its trust flag", typeof recorded?.trusted === "boolean", JSON.stringify(recorded?.trusted));

// Cleanup.
for (const cmp of [cmp3]) {
  await evalJs(`window.pi.discardWorldline(${JSON.stringify(cmp)})`);
}
await sleep(1500);
const left = await evalJs(`window.pi.getWorldlines()`);
check("no candidates remain", (left ?? []).length === 0, JSON.stringify(left));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
