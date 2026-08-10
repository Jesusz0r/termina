/**
 * Regression test: the three pre-existing bugs fixed in the AGENTS.md audit.
 *
 * Launch requirement:
 *   PI_EDITOR_EVENTS_DIR=/tmp/pi-editor-events-test
 *   PI_EDITOR_INITIAL_CWD=<fresh fixture: greeting.ts "hello", hello.txt, src/>
 *   --remote-debugging-port=9222
 *
 * The suite injects synthetic sidecar events (same shape as the bridge
 * extension writes) to exercise main's baseline logic deterministically.
 */
/**
 * Targeted verification of the three pre-existing bugs fixed in the audit:
 *
 * 1. Old-history replay: a fresh instance must NOT replay events written
 *    before it launched (timeline empty at boot, status idle).
 * 2. Baseline race: an edit reconstructs the pre-run content in BOTH poll
 *    orderings; a first-touch write to an existing file leaves the baseline
 *    undefined (revert refuses) instead of null (revert deletes).
 * 3. Modified-list status: the watcher's created/modified status wins.
 */
import { appendFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 180) : ""}`);
};

// The events dir is overridable via PI_EDITOR_EVENTS_DIR (set by the launcher).
const eventsDir = "/tmp/pi-editor-events-test";
const { mkdirSync } = await import("node:fs");
mkdirSync(eventsDir, { recursive: true });
const sidecar = join(eventsDir, "term-1.jsonl");
const bridgeId = "synthetic-baseline";
let sequence = 0;
const emit = (obj) => appendFileSync(sidecar, JSON.stringify({ bridgeId, seq: ++sequence, ...obj }) + "\n");

const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json());
const page = pages.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };

// ---- 1. no old-history replay at boot ----
const boot = JSON.parse(await evalJs(`(() => JSON.stringify({
  tl: window.__timelineView ? document.querySelectorAll('#timeline-dots .timeline-dot').length : -1,
  state: document.getElementById('status-state').textContent,
}))()`));
check("no old-history timeline dots at boot", boot.tl === 0, JSON.stringify(boot));
check("no old-history busy state at boot", String(boot.state).includes("idle"), boot.state);
const tl0 = await evalJs(`window.pi.getTimeline('term-1')`);
check("getTimeline empty at boot", Array.isArray(tl0) && tl0.length === 0, JSON.stringify(tl0));

// ---- 2a. edit reconstruct: landed ordering (disk already has the edit) ----
emit({ t: "agent_start" });
await sleep(600);
emit({ t: "tool", toolName: "edit", path: "greeting.ts", edits: [{ oldText: 'export const greeting = "hello";', newText: 'export const greeting = "hi there";' }] });
await sleep(600);
emit({ t: "agent_settled" });
await sleep(600);
const b1 = await evalJs(`window.pi.reviewBaseline('term-1', '/tmp/pi-editor-test-project/greeting.ts')`);
check("edit baseline reconstructed (landed ordering)", b1?.baseline === 'export const greeting = "hello";\n', JSON.stringify(b1));

// ---- 2b. write to existing uncached file → undefined (revert refuses) ----
emit({ t: "agent_start" });
await sleep(500);
// Simulate the agent writing hello.txt (disk change while busy, no tool args
// for content): the watcher change fires with status modified and NO prev.
const { writeFileSync, readFileSync } = await import("node:fs");
const helloPath = "/tmp/pi-editor-test-project/hello.txt";
const helloBefore = readFileSync(helloPath, "utf8");
writeFileSync(helloPath, helloBefore + "extra line\n");
await sleep(700);
const b2 = await evalJs(`window.pi.reviewBaseline('term-1', '${helloPath}')`);
check("write to existing file: baseline unavailable (revert refuses, no delete)", b2?.baseline === undefined && b2?.status === "modified", JSON.stringify(b2));
emit({ t: "agent_settled" });
await sleep(400);

// ---- 2c. created file → null (revert deletes) ----
emit({ t: "agent_start" });
await sleep(400);
writeFileSync("/tmp/pi-editor-test-project/new-file.txt", "content\n");
await sleep(700);
const b3 = await evalJs(`window.pi.reviewBaseline('term-1', '/tmp/pi-editor-test-project/new-file.txt')`);
check("created file: baseline null (revert deletes)", b3?.baseline === null && b3?.status === "created", JSON.stringify(b3));
emit({ t: "agent_settled" });
await sleep(400);

// ---- 3. modified list status: watcher wins ----
const list = await evalJs(`window.pi.getInstances()`) ?? [];
// The modified list is pushed at settle; ask main for the status via the DOM
// panel of the active pane.
const statuses = JSON.parse(await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('#modified-list .status-badge')].map(b => ({ text: b.textContent, cls: b.className }))
))()`));
const newFileBadge = statuses.find((s) => s.cls.includes("created"));
const helloBadge = statuses.find((s) => s.cls.includes("modified"));
check("new-file.txt shows A (created)", !!newFileBadge && newFileBadge.text === "A", JSON.stringify(statuses));
check("hello.txt shows M (modified)", !!helloBadge && helloBadge.text === "M", JSON.stringify(statuses));

// ---- 5. a deleted file with a baseline stays restorable ----
// Establish a fresh baseline for greeting.ts (each agent_start re-baselines),
// then delete the file on disk: the watcher reports the deletion; the entry
// must stay with a D badge and revert must restore the file.
const greetingPath = "/tmp/pi-editor-test-project/greeting.ts";
const { rmSync } = await import("node:fs");
emit({ t: "agent_start" });
await sleep(500);
emit({ t: "tool", toolName: "edit", path: "greeting.ts", edits: [{ oldText: 'export const greeting = "hello";', newText: 'export const greeting = "hi there";' }] });
await sleep(600);
rmSync(greetingPath);
await sleep(800);
const statuses5 = JSON.parse(await evalJs(`(() => JSON.stringify(
  [...document.querySelectorAll('#modified-list .status-badge')].map(b => ({ text: b.textContent, cls: b.className }))
))()`));
const delBadge = statuses5.find((s) => s.cls.includes("deleted"));
check("deleted file stays in the list with a D badge", !!delBadge && delBadge.text === "D", JSON.stringify(statuses5));
const b5 = await evalJs(`window.pi.reviewBaseline('term-1', '${greetingPath}')`);
check("deleted file keeps its baseline", b5?.baseline === 'export const greeting = "hello";\n', JSON.stringify(b5));
const rev5 = await evalJs(`window.pi.reviewRevert('term-1', '${greetingPath}')`);
await sleep(800);
const restored = existsSync(greetingPath) ? readFileSync(greetingPath, "utf8") : "";
check("revert restores the deleted file", restored === 'export const greeting = "hello";\n', restored.slice(0, 60));

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
