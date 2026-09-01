/**
 * Phase 2 e2e: run-boundary recording.
 *
 * Expects Electron on TERMINA_E2E_PORT with TERMINA_INITIAL_CWD set to a Git repo
 * containing greeting.ts ("export const greeting = \"hello\";") and
 * TERMINA_EVENTS_DIR set to a clean dedicated directory.
 *
 * Proves the Phase 2 acceptance (WORLDLINES §7): every run offered by Fork
 * Run reconstructs start and settled source bytes and session branches
 * exactly inside the declared boundary.
 *   1. a clean run records start + settled source states, the effective
 *      prompt, the session entries, and a session branch copy
 *   2. the recorded states materialize byte-for-byte (pre-run and post-run)
 *   3. the user's Git metadata (HEAD, refs, index) is untouched
 *   4. a steering message makes the run non-replayable
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "./wait-for.mjs";
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

const PROJ = process.env.TERMINA_INITIAL_CWD ?? "/tmp/termina-wline-project";
const EVENTS = process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-wline-events";
const greeting = join(PROJ, "greeting.ts");
const git = (args) => execFileSync("git", args, { cwd: PROJ, encoding: "utf8" }).trim();
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const repoState = () => ({
  head: git(["rev-parse", "HEAD"]),
  refs: git(["for-each-ref"]),
  indexSha: sha256(join(PROJ, ".git", "index")),
});

async function typePrompt(text) {
  await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
  await send("Input.insertText", { text });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

/** Poll getRuns until a run matches the predicate or the deadline passes. */
async function waitForRun(predicate, timeoutMs = 120000) {
  return waitFor(async () => {
    const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
    return runs.find(predicate);
  }, timeoutMs);
}

// ---------------------------------------------------------------- run 1 ----
// The agent edits greeting.ts. The run must settle as replayable.
const before = repoState();
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run1 = await waitForRun((r) => r.settledAt !== null && r.promptText?.includes("hi there"));
check("the run settled and recorded", run1 !== null, JSON.stringify(run1?.id ?? null));
if (!run1) process.exit(1);

check("the clean run is replayable", run1.replayable === true, run1.reason ?? "");
check("start and settled states recorded and differ", !!run1.startStateId && !!run1.settledStateId && run1.startStateId !== run1.settledStateId);
check("the prompt text is the effective prompt", run1.promptText?.includes("hi there") ?? false, run1.promptText ?? "null");
check("session entry ids recorded", !!run1.promptEntryId && !!run1.promptParentEntryId, JSON.stringify([run1.promptEntryId, run1.promptParentEntryId]));
check("the session file exists", !!run1.sessionFile && existsSync(run1.sessionFile), run1.sessionFile ?? "null");
check("the session branch was copied app-private", !!run1.sessionBranchFile && existsSync(run1.sessionBranchFile), run1.sessionBranchFile ?? "null");

// The start state is the pre-run bytes; the settled state is the post-run.
const startExp = await evalJs(`window.pi.exportState(${JSON.stringify(run1.id)}, "start")`);
const settledExp = await evalJs(`window.pi.exportState(${JSON.stringify(run1.id)}, "settled")`);
check("start state materializes", startExp?.ok === true, JSON.stringify(startExp));
check("settled state materializes", settledExp?.ok === true, JSON.stringify(settledExp));
if (startExp?.ok && settledExp?.ok) {
  check("start bytes are the pre-run file", readFileSync(join(startExp.dir, "greeting.ts"), "utf8") === 'export const greeting = "hello";\n', readFileSync(join(startExp.dir, "greeting.ts"), "utf8"));
  const settledContent = readFileSync(join(settledExp.dir, "greeting.ts"), "utf8");
  check("settled bytes are the post-run file", settledContent.includes("hi there"), settledContent.slice(0, 80));
}

// The user's Git metadata is untouched by capture.
const after = repoState();
check("HEAD unchanged", before.head === after.head);
check("refs unchanged", before.refs === after.refs);
check("index unchanged", before.indexSha === after.indexSha);

// The timeline of the same run still works (existing behavior kept).
const tl = await evalJs(`window.pi.getTimeline("term-1")`);
check("timeline still records the run", (tl ?? []).some((e) => e.t === "agent_start") && (tl ?? []).some((e) => e.t === "agent_settled"), JSON.stringify((tl ?? []).map((e) => e.t)));

// ---------------------------------------------------------------- run 2 ----
// A steering message typed mid-run makes the run non-replayable.
await typePrompt("Add a file notes.md with a detailed summary of the greeting file and list every file in the project");
const run2Open = await waitForRun((r) => r.startedAt > (run1.settledAt ?? 0) && r.settledAt === null, 60000);
check("the second run opened", run2Open !== null, JSON.stringify(run2Open?.id ?? null));
if (run2Open) {
  // Steer while the run is still active.
  await typePrompt("Actually stop. Read the file only.");
}
const run2 = await waitForRun((r) => r.startedAt > (run1.settledAt ?? 0) && r.settledAt !== null, 120000);
check("the steered run settled", run2 !== null, JSON.stringify(run2?.id ?? null));
if (run2) {
  check("the steered run is not replayable", run2.replayable === false, JSON.stringify(run2));
  check("the steering flag is recorded", run2.steering === true);
  check("the reason names the steering", (run2.reason ?? "").includes("steering"), run2.reason ?? "");
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
