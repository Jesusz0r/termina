/**
 * Phase 5 e2e: promotion with rollback-ready journaling.
 *
 * Expects Electron on :9222 with:
 *   TERMINA_INITIAL_CWD=<Git repo: greeting.ts "hello", other.txt "other">
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<clean dedicated worlds root>
 *
 * Proves the Phase 5 acceptance (WORLDLINES §7): a candidate promotes into
 * the primary through a recoverable three-way merge without touching user
 * Git metadata, and the result lands in primary Change Review on a promoted
 * terminal.
 *   1. a completed run forks; the primary is then reverted and edited by
 *      the user (independent changes)
 *   2. Mine enforcement rejects a promotion that touches an owned file
 *   3. a real text conflict rejects the promotion and keeps the pair usable
 *   4. the clean merge promotes: candidate change applies, independent
 *      primary changes survive, journal is consumed
 *   5. the promoted session installs and its terminal opens (active tab)
 *   6. the promoted Change Review carries the pre-promotion baseline
 *   7. primary HEAD/refs/index stay untouched; the pair is cleaned up
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";

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

const PROJ = "/tmp/termina-wline3-project";
const EVENTS = "/tmp/termina-wline3-events";
const WORLDS = "/tmp/termina-wline3-worlds";
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

const journalRoot = join(WORLDS, "promotion-journal");

// ---------------------------------------------------------------- run 1 ----
const before = repoState();
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.find((r) => r.settledAt !== null && r.replayable === true) ?? null;
}, 240000);
check("a replayable run exists", run !== null, JSON.stringify(run?.id ?? null));
if (!run) process.exit(1);

// The user reverted the run result and made an independent change: the
// primary now diverges from the run in both directions.
writeFileSync(join(PROJ, "greeting.ts"), 'export const greeting = "hello";\n');
writeFileSync(join(PROJ, "other.txt"), "other2\n");
await sleep(1500);

// ---------------------------------------------------------------- fork ----
const fork = await evalJs(`window.pi.forkRun(${JSON.stringify(run.id)})`);
check("fork-run starts", fork?.ok === true, JSON.stringify(fork));
if (!fork?.ok) process.exit(1);
const comparisonId = fork.comparisonId;
const ready = await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  if (list.some((w) => w.comparisonId === comparisonId && w.state === "error")) return { error: true };
  const pair = list.filter((w) => w.comparisonId === comparisonId);
  if (pair.length === 2 && pair.every((w) => w.state === "ready")) return { pair };
  return null;
}, 180000);
check("both candidates become ready", ready !== null && !("error" in ready), JSON.stringify(ready));
if (!ready || "error" in ready) process.exit(1);
const a = ready.pair.find((w) => w.label === "A");

// -------------------------------------------------- Mine enforcement ----
await evalJs(`window.pi.setMineFile(${JSON.stringify(join(PROJ, "greeting.ts"))}, true)`);
const mineReject = await evalJs(`window.pi.promoteWorldline(${JSON.stringify(comparisonId)}, "A")`);
check("promotion rejects a Mine path", mineReject?.ok === false && String(mineReject?.error ?? "").includes("you own"), JSON.stringify(mineReject));
await evalJs(`window.pi.setMineFile(${JSON.stringify(join(PROJ, "greeting.ts"))}, false)`);
await sleep(800);

// --------------------------------------------------- conflict rejection ----
writeFileSync(join(PROJ, "greeting.ts"), 'export const greeting = "user conflict version";\n');
await sleep(1200);
const conflictReject = await evalJs(`window.pi.promoteWorldline(${JSON.stringify(comparisonId)}, "A")`);
check("promotion rejects a text conflict", conflictReject?.ok === false && String(conflictReject?.error ?? "").includes("conflict"), JSON.stringify(conflictReject));
const stillThere = await evalJs(`window.pi.getWorldlines()`);
check("the pair stays usable after rejection", (stillThere ?? []).some((w) => w.comparisonId === comparisonId && w.label === "A" && w.state === "ready"), JSON.stringify(stillThere));
writeFileSync(join(PROJ, "greeting.ts"), 'export const greeting = "hello";\n');
await sleep(1200);

// ------------------------------------------------------- clean promotion ----
// The confirmation contract (WORLDLINES §6.10): no evidence has been
// computed yet, so the first call asks for explicit confirmation and the
// forced call proceeds.
const promoteAsk = await evalJs(`window.pi.promoteWorldline(${JSON.stringify(comparisonId)}, "A")`);
check("promotion asks for confirmation without evidence", promoteAsk?.ok === false && typeof promoteAsk?.confirm === "string" && String(promoteAsk.confirm).includes("evidence"), JSON.stringify(promoteAsk));
const promote = await evalJs(`window.pi.promoteWorldline(${JSON.stringify(comparisonId)}, "A", true)`);
check("promotion succeeds", promote?.ok === true, JSON.stringify(promote));
if (!promote?.ok) process.exit(1);
const promotedId = promote.terminalId;

check("candidate change applied", readFileSync(join(PROJ, "greeting.ts"), "utf8").includes("hi there"), readFileSync(join(PROJ, "greeting.ts"), "utf8").slice(0, 60));
check("independent primary change survives", readFileSync(join(PROJ, "other.txt"), "utf8").includes("other2"), readFileSync(join(PROJ, "other.txt"), "utf8").slice(0, 60));

// The journal is consumed (phase done then removed).
await waitFor(async () => {
  if (!existsSync(journalRoot)) return true;
  return readdirSync(journalRoot).length === 0;
}, 15000);
check("promotion journal consumed", !existsSync(journalRoot) || readdirSync(journalRoot).length === 0, "");

// The promoted session installs into the primary session directory. pi
// canonicalizes the cwd (/tmp → /private/tmp), so scan both name forms.
const safePath = (p) => `--${p.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
const sessionDirs = [
  join(homedir(), ".pi", "agent", "sessions", safePath(PROJ)),
  join(homedir(), ".pi", "agent", "sessions", safePath(realpathSync(PROJ))),
];
// The primary pi terminal also writes sessions here; find the promoted one
// by its content (both relocation notes), not by name or mtime. The promoted
// pi rewrites the file while it boots — retry through the transient partials.
const promotedSession = await waitFor(() => {
  for (const sessionsDir of sessionDirs) {
    if (!existsSync(sessionsDir)) continue;
    for (const f of readdirSync(sessionsDir).filter((x) => x.endsWith(".jsonl"))) {
      try {
        const text = readFileSync(join(sessionsDir, f), "utf8");
        if (text.includes("termina-relocation") && text.includes("In this promoted session")) return join(sessionsDir, f);
      } catch {
        /* a session mid-write: retry */
      }
    }
  }
  return null;
}, 15000);
check("promoted session installed", promotedSession !== null, "");
if (promotedSession) {
  const text = readFileSync(promotedSession, "utf8");
  check("promoted session carries the relocation note", text.includes("termina-relocation"), "relocation present");
  check("promoted session points at the primary cwd", text.includes(PROJ), "primary cwd present");
}

// The promoted terminal opened and became the active tab.
const activeTab = await waitFor(async () => {
  const tabs = await evalJs(
    `[...document.querySelectorAll('.terminal-tab')].map((t) => ({ active: t.classList.contains('active'), name: t.querySelector('.tab-name')?.textContent }))`,
  );
  return tabs.length >= 2 && tabs.filter((t) => t.active).length === 1 && tabs.at(-1)?.active ? tabs : null;
}, 30000);
check("promoted terminal opened and is active", activeTab !== null, JSON.stringify(activeTab));

// The promoted Change Review carries the pre-promotion baseline.
const baseline = await evalJs(`window.pi.reviewBaseline(${JSON.stringify(promotedId)}, ${JSON.stringify(join(PROJ, "greeting.ts"))})`);
check("promoted review baseline is the pre-promotion content", baseline?.status === "modified" && baseline?.baseline?.includes("hello"), JSON.stringify(baseline));
const insts = await evalJs(`window.pi.getInstances()`);
const promotedInst = (insts ?? []).find((i) => i.id === promotedId);
check("promoted terminal is a primary agent", promotedInst?.type === "agent" && promotedInst?.cwd === PROJ, JSON.stringify(promotedInst));

// ------------------------------------------------- primary stays clean ----
const after = repoState();
check("HEAD unchanged", before.head === after.head);
check("refs unchanged", before.refs === after.refs);
check("index unchanged", before.indexSha === after.indexSha);
const listAfter = await evalJs(`window.pi.getWorldlines()`);
check("the comparison is torn down after promotion", (listAfter ?? []).filter((w) => w.comparisonId === comparisonId).length === 0, JSON.stringify(listAfter));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
