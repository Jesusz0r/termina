/**
 * Phase 4 e2e: comparison and Verify for Fork Run candidates.
 *
 * Expects Electron on TERMINA_E2E_PORT with:
 *   TERMINA_INITIAL_CWD=<Git repo with greeting.ts "hello", package.json
 *     with a test script, and test.js that requires "hi there">
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<clean dedicated worlds root>
 *
 * Proves the Phase 4 acceptance (WORLDLINES §7): both candidates can Verify
 * and compare without primary writes.
 *   1. the Fork Run button enables for the completed run and forks the pair
 *   2. the candidate terminal tabs carry the A/B badges
 *   3. details on demand: changed files, source statistics, dependencies
 *   4. Verify runs inside each candidate tree (A passes, B fails)
 *   5. base → candidate and A ⇄ B diffs open in Change Review
 *   6. primary Git metadata stays untouched
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
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

const PROJ = process.env.TERMINA_INITIAL_CWD ?? "/tmp/termina-wline2-project";
const EVENTS = process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-wline2-events";
const WORLDS = process.env.TERMINA_WORLDS_DIR ?? "/tmp/termina-wline2-worlds";
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

const verifyContext = (cmpId, label) => {
  const dir = join(WORLDS, cmpId, `${label}-support`, "events");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.startsWith("verify-") && f.endsWith(".md"));
  return files.length ? join(dir, files[0]) : null;
};
const readVerifyContext = (cmpId, label) => {
  const p = verifyContext(cmpId, label);
  return p ? readFileSync(p, "utf8") : null;
};

// ---------------------------------------------------------------- run 1 ----
const before = repoState();
await typePrompt("Edit greeting.ts so the greeting is hi there");
const run = await waitFor(async () => {
  const runs = (await evalJs(`window.pi.getRuns("term-1")`)) ?? [];
  return runs.find((r) => r.settledAt !== null && r.replayable === true) ?? null;
}, 240000);
check("a replayable run exists", run !== null, JSON.stringify(run?.id ?? null));
if (!run) process.exit(1);

// ------------------------------------------------- Fork Run button + fork ----
const btn = await waitFor(async () => {
  const b = await evalJs(
    `(() => { const b = document.getElementById('btn-fork-run'); return b.hidden ? null : { disabled: b.disabled, title: b.title }; })()`,
  );
  return b && b.disabled === false ? b : null;
}, 30000);
check("Fork Run button enabled with the run", btn !== null, JSON.stringify(btn));
await evalJs(`document.getElementById('btn-fork-run').click()`);
const comparisonId = await waitFor(async () => {
  const list = (await getWorldlines()) ?? [];
  // Match the pair to the run just forked: a stale pair left by a crashed
  // prior run must not hijack the suite.
  const pair = list.filter((w) => w.sourceRunId === run.id);
  if (pair.length === 2) return pair[0].comparisonId;
  return null;
}, 30000);
check("fork-run starts from the button", comparisonId !== null, JSON.stringify(comparisonId));
if (!comparisonId) process.exit(1);

// --------------------------------------------------- candidates become ready
const ready = await waitFor(async () => {
  const list = (await getWorldlines()) ?? [];
  if (list.some((w) => w.comparisonId === comparisonId && w.state === "error")) {
    return { error: list.find((w) => w.comparisonId === comparisonId && w.state === "error")?.error ?? "error" };
  }
  const pair = list.filter((w) => w.comparisonId === comparisonId);
  if (pair.length === 2 && pair.every((w) => w.state === "ready")) return { pair };
  return null;
}, 180000);
check("both candidates become ready", ready !== null && !("error" in ready), JSON.stringify(ready));
if (!ready || "error" in ready) process.exit(1);
const a = ready.pair.find((w) => w.label === "A");
const b = ready.pair.find((w) => w.label === "B");
check("summaries carry model and provenance", typeof a.model === "string" && typeof a.createdAt === "number" && a.sourceRunId === run.id, JSON.stringify({ model: a.model, createdAt: a.createdAt }));

// ----------------------------------------------------------- A/B badges ----
await sleep(500);
const badges = await evalJs(
  `[...document.querySelectorAll('.terminal-tab .tab-worldline')].map((el) => ({ text: el.textContent, shown: el.style.display !== 'none' }))`,
);
const shownBadges = (badges ?? []).filter((x) => x.shown);
check(
  "candidate terminal tabs carry A/B badges",
  shownBadges.length === 2 && shownBadges.some((x) => x.text === "A") && shownBadges.some((x) => x.text === "B"),
  JSON.stringify(badges),
);

// --------------------------------------------------- details on demand ----
const detailsA = await evalJs(`window.pi.getWorldlineDetails(${JSON.stringify(comparisonId)}, "A")`);
check("details ok for A", detailsA?.ok === true, JSON.stringify(detailsA?.error ?? ""));
const changedA = (detailsA?.details?.changedFiles ?? []).map((f) => f.relPath);
check("A changed greeting.ts vs base", changedA.includes("greeting.ts"), JSON.stringify(changedA));
check("A source statistics present", detailsA.details.sourceFiles >= 3 && detailsA.details.sourceBytes > 0, JSON.stringify({ files: detailsA.details.sourceFiles, bytes: detailsA.details.sourceBytes }));
check("A age and provenance present", detailsA.details.ageMs >= 0 && detailsA.details.sourceRunId === run.id, JSON.stringify(detailsA.details.ageMs));
const detailsB = await evalJs(`window.pi.getWorldlineDetails(${JSON.stringify(comparisonId)}, "B")`);
check("details ok for B", detailsB?.ok === true, JSON.stringify(detailsB?.error ?? ""));
check("B changed nothing vs base", (detailsB?.details?.changedFiles ?? []).length === 0, JSON.stringify(detailsB?.details?.changedFiles));

// ------------------------------------------------------ Verify in A and B ----
check("A terminal verifies green", await (async () => {
  const res = await evalJs(`window.pi.runVerify(${JSON.stringify(a.terminalId)})`);
  if (!res?.ok) return false;
  const ctx = await waitFor(() => readVerifyContext(comparisonId, "A"), 120000);
  return ctx !== null && ctx.includes("✅ PASSED");
})());
check("B terminal verifies red", await (async () => {
  const res = await evalJs(`window.pi.runVerify(${JSON.stringify(b.terminalId)})`);
  if (!res?.ok) return false;
  const ctx = await waitFor(() => readVerifyContext(comparisonId, "B"), 120000);
  return ctx !== null && ctx.includes("❌ FAILED");
})());

// ---------------------------------------------------------- compare flows ----
const baseFile = await evalJs(`window.pi.getWorldlineBaseFile(${JSON.stringify(comparisonId)}, "greeting.ts")`);
check("base file is the run start", baseFile?.ok === true && baseFile.content.includes("hello"), String(baseFile?.content ?? "").slice(0, 60));
const aFile = await evalJs(`window.pi.getWorldlineFile(${JSON.stringify(comparisonId)}, "A", "greeting.ts")`);
check("A file is the settled state", aFile?.ok === true && aFile.content.includes("hi there"), String(aFile?.content ?? "").slice(0, 60));
const bFile = await evalJs(`window.pi.getWorldlineFile(${JSON.stringify(comparisonId)}, "B", "greeting.ts")`);
check("B file is the start state", bFile?.ok === true && bFile.content.includes("hello"), String(bFile?.content ?? "").slice(0, 60));

// The candidate card: expand details, click the changed file → Change Review.
await evalJs(`document.querySelector('.candidate-card[data-label="A"] .cand-details').click()`);
const changedItem = await waitFor(async () => {
  const items = await evalJs(`[...document.querySelectorAll('.candidate-card[data-label="A"] .cand-changed li .path')].map((el) => el.textContent)`);
  return items.includes("greeting.ts") ? items : null;
}, 30000);
check("card details list the changed file", changedItem !== null, JSON.stringify(changedItem));
await evalJs(`[...document.querySelectorAll('.candidate-card[data-label="A"] .cand-changed li')].find((li) => li.textContent.includes('greeting.ts')).click()`);
await waitFor(async () => (await evalJs(`document.getElementById('review-container').style.display`)) === "flex", 15000);
const reviewName = await evalJs(`document.getElementById('review-filename').textContent`);
check("base → A diff opens in Change Review", typeof reviewName === "string" && reviewName.includes("greeting.ts") && reviewName.includes("A"), String(reviewName));
const reviewDebug = await evalJs(`window.__reviewDebug`);
check("diff sides are base and A", String(reviewDebug?.original ?? "").includes("hello") && String(reviewDebug?.modified ?? "").includes("hi there"), JSON.stringify(reviewDebug));
await evalJs(`document.getElementById('review-back').click()`);

// The A ⇄ B modal: open, pick the file, the diff shows A vs B.
await evalJs(`document.querySelector('.cmp-ab').click()`);
const abItems = await waitFor(async () => {
  const items = await evalJs(`[...document.querySelectorAll('.worldline-list li .path')].map((el) => el.textContent)`);
  return items.length > 0 ? items : null;
}, 15000);
check("A ⇄ B modal lists the changed files", abItems !== null && abItems.includes("greeting.ts"), JSON.stringify(abItems));
await evalJs(`[...document.querySelectorAll('.worldline-list li')].find((li) => li.textContent.includes('greeting.ts')).click()`);
await waitFor(async () => (await evalJs(`document.getElementById('review-container').style.display`)) === "flex", 15000);
const reviewNameAB = await evalJs(`document.getElementById('review-filename').textContent`);
check("A ⇄ B diff opens in Change Review", typeof reviewNameAB === "string" && reviewNameAB.includes("greeting.ts") && reviewNameAB.includes("A ⇄ B"), String(reviewNameAB));
const reviewDebugAB = await evalJs(`window.__reviewDebug`);
check("A ⇄ B sides are A and B", String(reviewDebugAB?.original ?? "").includes("hi there") && String(reviewDebugAB?.modified ?? "").includes("hello"), JSON.stringify(reviewDebugAB));
await evalJs(`document.getElementById('review-back').click()`);

// ------------------------------------------------ primary stays untouched ----
const after = repoState();
check("HEAD unchanged", before.head === after.head);
check("refs unchanged", before.refs === after.refs);
check("index unchanged", before.indexSha === after.indexSha);
check("no verify artifacts in the primary", !existsSync(join(PROJ, "test-output.txt")), "");

// --------------------------------------------------------------- discard ----
const disc = await evalJs(`window.pi.discardWorldline(${JSON.stringify(comparisonId)})`);
check("discard ok", disc?.ok === true, JSON.stringify(disc));
await sleep(1500);
const listAfter = await getWorldlines();
check("worldline list is empty after discard", (listAfter ?? []).filter((w) => w.comparisonId === comparisonId).length === 0, JSON.stringify(listAfter));

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
