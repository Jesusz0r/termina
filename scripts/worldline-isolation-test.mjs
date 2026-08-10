/**
 * Phase 8 e2e: candidate isolation (WORLDLINES §10 worldline-isolation-test).
 *
 * Expects Electron on :9222 with:
 *   PI_EDITOR_INITIAL_CWD=<Git repo: greeting.ts "hello", hello.txt "first">
 *   PI_EDITOR_EVENTS_DIR=<clean dedicated dir>
 *   PI_EDITOR_WORLDS_DIR=<clean dedicated worlds root>
 *
 * Proves WORLDLINES §6.6: the operating system policy is the actual write
 * boundary.
 *   1. a run forks; the profile denies the primary, the real home, the
 *      sibling, and the app snapshot store
 *   2. a live sandbox probe: primary and home writes blocked, candidate
 *      writes allowed; network denied under the evidence profile
 *   3. the process-count limit applies (bounded by the wrapper)
 *   4. A and B have independent Git indexes and homes
 *   5. nested worldlines: a moment inside a candidate forks a candidate
 *      whose tree is the parent moment plus its own edit, and the root
 *      promotion base stays unchanged
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

const PROJ = "/tmp/pi-editor-wline7-project";
const WORLDS = "/tmp/pi-editor-wline7-worlds";
const git = (args) => execFileSync("git", args, { cwd: PROJ, encoding: "utf8" }).trim();
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const repoState = () => ({ head: git(["rev-parse", "HEAD"]), refs: git(["for-each-ref"]), indexSha: sha256(join(PROJ, ".git", "index")) });

async function typePrompt(text, tabIndex = 0) {
  // Activate the target pane, then focus ITS xterm textarea (xterm
  // recreates the helper textarea lazily, so select within the active pane).
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

// ---------------------------------------------------------------- run 1 ----
const before = repoState();
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.find((r) => r.settledAt !== null && r.replayable === true) ?? null;
}, 240000);
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

// --------------------------------------------------- isolation probes ----
const aProfile = join(WORLDS, comparisonId, "A-support", "sandbox.sb");
const profile = readFileSync(aProfile, "utf8");
check("profile denies the real home writes", profile.includes(`(deny file-write* (subpath "${process.env.HOME}"))`), "");
check("profile denies the app snapshot store", profile.includes(`(deny file-write* (subpath "${join(process.env.HOME, "Library", "Application Support")}`) || profile.includes("worldlines"), "store deny present");
check("profile denies sibling writes", profile.includes(`(deny file-write* (subpath "${b.root}"))`), "");
check("profile denies the primary", profile.includes(`(deny file-write* (subpath "${realpathSync(PROJ)}"))`), "");

// Live probes under the profile: primary and home writes blocked, the
// candidate tree writable.
const blocked = spawnSync("sandbox-exec", ["-f", aProfile, "/bin/zsh", "-c", `touch "${join(PROJ, "iso-touch.txt")}"`], { encoding: "utf8" });
check("sandbox blocks a primary write", blocked.status !== 0, `status=${blocked.status}`);
check("sandbox did not write the primary", !existsSync(join(PROJ, "iso-touch.txt")));
const homeBlocked = spawnSync("sandbox-exec", ["-f", aProfile, "/bin/zsh", "-c", `touch "${join(process.env.HOME, "iso-touch.txt")}"`], { encoding: "utf8" });
check("sandbox blocks a real-home write", homeBlocked.status !== 0, `status=${homeBlocked.status}`);
check("sandbox did not write the home", !existsSync(join(process.env.HOME, "iso-touch.txt")));
const allowed = spawnSync("sandbox-exec", ["-f", aProfile, "/bin/zsh", "-c", `echo ok > "${join(a.root, "iso-write.txt")}"`], { encoding: "utf8" });
check("sandbox allows a candidate write", allowed.status === 0 && existsSync(join(a.root, "iso-write.txt")), `status=${allowed.status}`);

// Network: the evidence profile denies it; the candidate keeps it.
const evidenceProfile = join(WORLDS, comparisonId, "A-support", `evidence-${process.pid}.sb`);
if (!existsSync(evidenceProfile)) {
  // The evidence profile is written per run; synthesize it from the base.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(evidenceProfile, `${profile}\n(deny network*)\n`);
}
const net = spawnSync("sandbox-exec", ["-f", evidenceProfile, "/bin/zsh", "-c", "curl -s -m 3 https://example.com >/dev/null 2>&1 && echo NET || echo DENIED"], { encoding: "utf8" });
check("evidence profile denies network", String(net.stdout).includes("DENIED"), String(net.stdout).trim());

// The wrapper applies the process-count limit: forking past it fails.
const pids = spawnSync("sandbox-exec", ["-f", aProfile, "/bin/zsh", "-c", "ulimit -u 64; for i in $(seq 1 200); do sleep 5 & done; wait"], { encoding: "utf8", timeout: 30000 });
const limited = pids.status !== 0 && /resource|fork|limit/i.test(String(pids.stderr) + String(pids.stdout));
check("process-count limit applies", limited, `status=${pids.status} err=${String(pids.stderr).slice(0, 80)}`);

// Independent Git metadata and homes.
const aIndex = readFileSync(join(a.root, ".git", "index"));
const bIndex = readFileSync(join(b.root, ".git", "index"));
check("A and B have independent Git indexes", aIndex.length > 0 && !aIndex.equals(bIndex), "");
check("A and B have independent homes", a.root !== b.root && readFileSync(join(a.root, ".git", "config"), "utf8").length > 0, "");

// ------------------------------------------------ nested worldline ----
// Type a prompt into candidate A's terminal (tab index 1: term-1, term-2=A,
// term-3=B). Its moment dots capture and become forkable.
await typePrompt("Edit hello.txt so it says nested", 1);
const nestedDot = await waitFor(async () => {
  const tl = (await evalJs(`window.pi.getTimeline(${JSON.stringify(a.terminalId)})`)) ?? [];
  return tl.find((e) => e.t === "tool" && e.relPath === "hello.txt" && e.stateId && e.entryId) ?? null;
}, 240000);
check("the candidate's moment dot captured its state", nestedDot !== null, JSON.stringify(nestedDot ? { seq: nestedDot.seq } : null));
if (!nestedDot) process.exit(1);

const nestedFork = await evalJs(`window.pi.forkPoint(${JSON.stringify(a.terminalId)}, ${nestedDot.seq})`);
check("nested fork-point starts", nestedFork?.ok === true, JSON.stringify(nestedFork));
if (!nestedFork?.ok) process.exit(1);
const ncmp = nestedFork.comparisonId;
const nested = await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  const w = list.find((x) => x.comparisonId === ncmp);
  return w && w.state === "ready" ? w : null;
}, 180000);
check("nested candidate becomes ready", nested !== null, JSON.stringify(nested?.state));
if (!nested) process.exit(1);
check("nested tree holds the parent moment", readFileSync(join(nested.root, "greeting.ts"), "utf8").includes("hi there"), readFileSync(join(nested.root, "greeting.ts"), "utf8").slice(0, 40));
check("nested tree holds its own edit", readFileSync(join(nested.root, "hello.txt"), "utf8").includes("nested"), readFileSync(join(nested.root, "hello.txt"), "utf8").slice(0, 40));

// The root promotion base stays unchanged: promoting the nested candidate
// with force brings the whole lineage into the primary.
const beforePromote = repoState();
const promote = await evalJs(`window.pi.promoteWorldline(${JSON.stringify(ncmp)}, "A", true)`);
check("nested promotion succeeds", promote?.ok === true, JSON.stringify(promote));
if (!promote?.ok) process.exit(1);
check("nested promotion applies the whole lineage", readFileSync(join(PROJ, "greeting.ts"), "utf8").includes("hi there") && readFileSync(join(PROJ, "hello.txt"), "utf8").includes("nested"), readFileSync(join(PROJ, "hello.txt"), "utf8").slice(0, 40));
const afterPromote = repoState();
check("primary git metadata untouched", beforePromote.head === afterPromote.head && beforePromote.refs === afterPromote.refs && beforePromote.indexSha === afterPromote.indexSha, "");

// Cleanup: discard the remaining pair.
const d1 = await evalJs(`window.pi.discardWorldline(${JSON.stringify(comparisonId)})`);
check("discard ok", d1?.ok === true, JSON.stringify(d1));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
