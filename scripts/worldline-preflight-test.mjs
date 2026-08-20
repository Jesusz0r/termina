/**
 * Phase 8 e2e: fork preflight rejections (WORLDLINES §10
 * worldline-preflight-test).
 *
 * The launcher sets TERMINA_INITIAL_CWD to one of the invalid fixtures;
 * the suite types one prompt, waits for the settled run, then asserts the
 * fork-run rejection with the exact stable reason. Fresh instance per case.
 *
 * Case fixtures (launcher-driven via PREFLIGHT_CASE):
 *   plain    — a clean repo: the fork must SUCCEED
 *   nogit    — a folder without a Git repository
 *   subdir   — a Git subdirectory: the fork must SUCCEED (capture is the opened folder)

 *   conflict — unresolved index entries (a merge conflict state)
 *   submodule— the repo contains a submodule
 *   autocrlf — core.autocrlf=true
 *   sparse   — a sparse checkout is active
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { waitFor as waitUntil } from "./wait-for.mjs";

const port = 9222;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
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

const CASE = process.env.PREFLIGHT_CASE ?? "plain";

async function typePrompt(text) {
  await evalJs(`document.querySelector('.xterm-helper-textarea')?.focus()`);
  await send("Input.insertText", { text });
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

const waitFor = (predicate, timeoutMs = 240000) => waitUntil(predicate, timeoutMs, 1000);

// A settled run of any kind (recorded or not) is enough to exercise the
// fork gate. The run may not record in invalid fixtures; the fork call
// still reaches the preflight checks. In a non-Git folder the run settles
// without recording at all — wait for the idle cycle instead.
if (CASE === "nogit") {
  await typePrompt("Edit greeting.ts so the greeting is hi there");
  // Require a working → idle transition: the idle state at boot must not
  // count as the agent having run.
  let seenWorking = false;
  const idle = await waitFor(async () => {
    const state = await evalJs(`document.getElementById('status-state')?.textContent ?? ''`);
    if (String(state).includes("working")) seenWorking = true;
    return seenWorking && !String(state).includes("working") ? state : null;
  }, 300000);
  check("the agent ran in the non-Git folder", idle !== null, String(idle));
} else {
  await typePrompt("Edit greeting.ts so the greeting is hi there");
  const run = await waitFor(async () => {
    const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
    return runs.filter((r) => r.settledAt !== null).at(-1) ?? null;
  }, 300000);
  check("a settled run exists", run !== null, JSON.stringify(run?.id ?? null));
  if (!run) process.exit(1);

  // The conflict fixture must survive the agent run (a model may resolve
  // unmerged entries it sees in git status). Re-create the state after the
  // run settles, before the fork gate runs.
  if (CASE === "conflict") {
    const proj = process.env.TERMINA_INITIAL_CWD ?? "/tmp/termina-preflight/repo";
    const headSha = execFileSync("git", ["rev-parse", "HEAD:conflict-file.txt"], { cwd: proj, encoding: "utf8" }).trim();
    const blobSha = execFileSync("git", ["hash-object", "conflict-file.txt"], { cwd: proj, encoding: "utf8" }).trim();
    execFileSync("git", ["update-index", "--force-remove", "--", "conflict-file.txt"], { cwd: proj });
    const lines = [
      `100644 ${headSha} 1\tconflict-file.txt`,
      `100644 ${blobSha} 2\tconflict-file.txt`,
      `100644 ${blobSha} 3\tconflict-file.txt`,
    ].join("\n") + "\n";
    execFileSync("git", ["update-index", "--index-info"], { cwd: proj, input: lines });
  }

  const fork = await evalJs(`window.pi.forkRun(${JSON.stringify(run.id)})`);
  switch (CASE) {
    case "plain":
      check("clean repo forks", fork?.ok === true, JSON.stringify(fork));
      break;
    case "subdir":
      check("Git subdirectory forks", fork?.ok === true, JSON.stringify(fork));
      break;
    case "conflict":
      check("unresolved index entries rejected", fork?.ok === false && String(fork?.error ?? "").includes("unresolved index"), JSON.stringify(fork));
      break;
    case "submodule":
      check("submodule rejected", fork?.ok === false && String(fork?.error ?? "").includes("submodule"), JSON.stringify(fork));
      break;
    case "autocrlf":
      check("autocrlf rejected", fork?.ok === false && String(fork?.error ?? "").includes("core.autocrlf is not false"), JSON.stringify(fork));
      break;
    case "sparse":
      check("sparse checkout rejected", fork?.ok === false && String(fork?.error ?? "").includes("sparse checkout"), JSON.stringify(fork));
      break;
    default:
      check("unknown case", false, CASE);
  }
}

if (CASE === "nogit") {
  // No recording exists in a non-Git folder: the run settles without a
  // checkpoint and the recorder state shows paused (the fork gate reason
  // surfaces there).
  const rec = await waitFor(async () => {
    const r = await evalJs(`(() => { const el = document.getElementById('timeline-recorder'); return { hidden: el.hidden, text: el.textContent }; })()`);
    return r && !r.hidden && r.text.includes("paused") ? r : null;
  }, 60000);
  check("non-Git folder shows the paused recorder state", rec !== null, JSON.stringify(rec));
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  const settled = runs.filter((r) => r.settledAt !== null);
  check("non-Git folder records no replayable run", settled.length === 0, JSON.stringify(runs.map((r) => ({ id: r.id, settled: r.settledAt !== null }))));
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
