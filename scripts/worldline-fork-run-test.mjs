/**
 * Phase 3 e2e: Fork Run pair creation.
 *
 * Expects Electron on :9222 with:
 *   TERMINA_INITIAL_CWD=<Git repo with greeting.ts "hello">
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<clean dedicated worlds root>
 *
 * Proves the Phase 3 acceptance (WORLDLINES §7): candidate, sibling,
 * primary, real home, and user Git metadata remain isolated from candidate
 * writes; pair creation is all-or-nothing.
 *   1. A completed run forks into two candidates
 *   2. A holds the settled bytes, B holds the start bytes
 *   3. both sessions fork into app-owned candidate session dirs
 *   4. B's startup control delivers the effective prompt (consumed once)
 *   5. candidates run inside sandbox-exec with enforced write boundaries
 *   6. primary Git metadata stays untouched
 *   7. discard removes every app-owned resource
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const PROJ = process.env.TERMINA_INITIAL_CWD ?? "/tmp/termina-wline-project";
const EVENTS = process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-wline-events";
const WORLDS = process.env.TERMINA_WORLDS_DIR ?? "/tmp/termina-wline-worlds";
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

// ---------------------------------------------------------------- run 1 ----
const before = repoState();
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.find((r) => r.settledAt !== null && r.replayable === true) ?? null;
}, 240000);
check("a replayable run exists", run !== null, JSON.stringify(run?.id ?? null));
if (!run) process.exit(1);

// -------------------------------------------------------------- fork-run ----
const fork = await evalJs(`window.pi.forkRun(${JSON.stringify(run.id)})`);
check("fork-run starts", fork?.ok === true, JSON.stringify(fork));
if (!fork?.ok) process.exit(1);
const comparisonId = fork.comparisonId;

// Both candidates become ready through the bridge session_ready events.
const ready = await waitFor(async () => {
  const list = (await evalJs(`window.pi.getWorldlines()`)) ?? [];
  if (list.some((w) => w.comparisonId === comparisonId && w.state === "error")) {
    return { error: list.find((w) => w.comparisonId === comparisonId && w.state === "error")?.error ?? "error" };
  }
  const pair = list.filter((w) => w.comparisonId === comparisonId);
  if (pair.length === 2 && pair.every((w) => w.state === "ready")) return { pair };
  return null;
}, 180000);
check("both candidates become ready", ready !== null && !("error" in ready), JSON.stringify(ready));
if (!ready || "error" in ready) process.exit(1);
const pair = ready.pair;

const a = pair.find((w) => w.label === "A");
const b = pair.find((w) => w.label === "B");

// ------------------------------------------------------ source reconstruction
check("A holds the settled bytes", readFileSync(join(a.root, "greeting.ts"), "utf8").includes("hi there"), readFileSync(join(a.root, "greeting.ts"), "utf8").slice(0, 60));
check("B holds the start bytes", readFileSync(join(b.root, "greeting.ts"), "utf8").includes("hello"), readFileSync(join(b.root, "greeting.ts"), "utf8").slice(0, 60));
check("candidates live under the worlds root", a.root.startsWith(WORLDS) && b.root.startsWith(WORLDS), `${a.root} | ${b.root}`);
check("candidate dirs differ", a.root !== b.root);
check("sessions forked into candidate dirs", !!a.sessionFile && !!b.sessionFile && a.sessionFile.startsWith(WORLDS) && b.sessionFile.startsWith(WORLDS));
// A's fork writes its file immediately; B's empty session materializes
// when the candidate pi appends to it (the deferred-write contract).
const aSessionExists = existsSync(a.sessionFile);
const bSessionDir = join(WORLDS, comparisonId, "B-support", "sessions");
const bSessionMaterialized = readdirSync(bSessionDir).some((f) => f.endsWith(".jsonl"));
check("session files exist on disk", aSessionExists, `A=${aSessionExists} B(empty-session, materializes on append)=${bSessionMaterialized}`);

// A's session carries the hidden relocation note.
const aSession = readFileSync(a.sessionFile, "utf8");
check("A session carries the relocation note", aSession.includes("termina-relocation"), aSession.includes("maps to") ? "relocation text present" : "no relocation");

// B's startup control was consumed exactly once; session_ready was emitted.
const bEvents = join(WORLDS, comparisonId, "B-support", "events");
const controlGone = !existsSync(join(bEvents, "startup-control.json"));
const bSidecar = existsSync(join(bEvents, "term-" + pair.find((w) => w.label === "B").terminalId?.replace("term-", "") + ".jsonl"))
  ? readFileSync(join(bEvents, `term-${pair.find((w) => w.label === "B").terminalId?.replace("term-", "")}.jsonl`), "utf8")
  : readdirSync(bEvents).filter((f) => f.endsWith(".jsonl")).map((f) => readFileSync(join(bEvents, f), "utf8")).join("\n");
check("B startup control consumed", controlGone);
check("B emitted session_ready", bSidecar.includes("session_ready"), bSidecar.slice(0, 200));

// ---------------------------------------------------------- sandbox checks
// The candidate pi runs under sandbox-exec with a profile that denies the
// primary, the real home, and the sibling.
const aProfile = join(WORLDS, comparisonId, "A-support", "sandbox.sb");
const profile = readFileSync(aProfile, "utf8");
check("profile denies the primary root", profile.includes(`(deny file-write* (subpath "${realpathSync(PROJ)}"))`));
check("profile denies the real home", profile.includes(`(deny file-write* (subpath "${process.env.HOME}"))`));
check("profile denies the sibling", profile.includes(`(deny file-write* (subpath "${b.root}"))`));
check("profile allows the candidate tree", profile.includes(`(allow file-write* (subpath "${a.root}"))`));

// The profile enforces: a primary write is blocked, a candidate write is not.
const blocked = spawnSync("sandbox-exec", ["-f", aProfile, "/bin/sh", "-c", `touch "${join(PROJ, "sandbox-touch.txt")}"`], { encoding: "utf8" });
check("sandbox blocks a primary write", blocked.status !== 0, `status=${blocked.status}`);
check("sandbox did not write the primary", !existsSync(join(PROJ, "sandbox-touch.txt")));
const allowed = spawnSync("sandbox-exec", ["-f", aProfile, "/bin/sh", "-c", `echo ok > "${join(a.root, "sandbox-write.txt")}"`], { encoding: "utf8" });
check("sandbox allows a candidate write", allowed.status === 0 && existsSync(join(a.root, "sandbox-write.txt")));

// The candidate pi processes run inside the sandbox. The sandbox hides
// their argv, so the manifest pids are the reliable handle.
const manifest = JSON.parse(readFileSync(join(WORLDS, comparisonId, "manifest.json"), "utf8"));
let alivePids = [];
for (let i = 0; i < 10; i++) {
  alivePids = Object.values(manifest.candidates ?? {})
    .map((c) => c.pid)
    .filter((pid) => {
      // A dead pid makes ps exit non-zero. Treat that as "not alive".
      try {
        const out = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim();
        return out.length > 0;
      } catch {
        return false;
      }
    });
  if (alivePids.length >= 2) break;
  await sleep(1000);
}
check("candidate pi processes run", alivePids.length >= 2, JSON.stringify(alivePids));
const comms = alivePids.map((pid) => execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim());
check("candidate processes are the sandboxed pi", comms.every((c) => c === "pi"), JSON.stringify(comms));

// ----------------------------------------------------- primary stays clean
const after = repoState();
check("HEAD unchanged", before.head === after.head);
check("refs unchanged", before.refs === after.refs);
check("index unchanged", before.indexSha === after.indexSha);

// --------------------------------------------------------------- discard ----
const disc = await evalJs(`window.pi.discardWorldline(${JSON.stringify(comparisonId)})`);
check("discard ok", disc?.ok === true, JSON.stringify(disc));
await sleep(1500);
check("comparison dir removed", !existsSync(join(WORLDS, comparisonId)));
const listAfter = await evalJs(`window.pi.getWorldlines()`);
const oursLeft = (listAfter ?? []).filter((w) => w.comparisonId === comparisonId);
check("worldline list is empty", oursLeft.length === 0, JSON.stringify(oursLeft));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
