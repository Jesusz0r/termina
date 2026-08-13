/**
 * Phase 5 e2e: promotion journal recovery at startup.
 *
 * Expects Electron on :9222 with:
 *   TERMINA_INITIAL_CWD=<Git repo: greeting.ts "hello", other.txt "other">
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<worlds root pre-seeded by the launcher with:
 *     promotion-journal/recovery-1/  (phase applied, greeting.ts applied)
 *     promotion-journal/recovery-2/  (phase done — must not roll back)
 *     promotion-journal/recovery-3/  (phase applied with an external
 *                                     change — a recovery conflict)>
 *
 * Proves WORLDLINES §6.10 steps 10-11: startup recovery rolls back only
 * app-written bytes before the primary watcher starts; a "done" journal
 * leaves the source alone; an externally changed path keeps every version
 * and stops automatic recovery with a conflict marker.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROJ = process.env.TERMINA_INITIAL_CWD ?? "/tmp/termina-wline4-project";
const WORLDS = process.env.TERMINA_WORLDS_DIR ?? "/tmp/termina-wline4-worlds";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const greetingPath = join(PROJ, "greeting.ts");
const journalRoot = join(WORLDS, "promotion-journal");

// The launcher seeded the journals and the disk states before this app boot.
check("applied journal rolled back the app-written bytes", readFileSync(greetingPath, "utf8").includes("hello"), readFileSync(greetingPath, "utf8").slice(0, 40));
check("done journal left the source untouched", readFileSync(join(PROJ, "other.txt"), "utf8").includes("done-state"), readFileSync(join(PROJ, "other.txt"), "utf8").slice(0, 40));
check("conflict journal kept every version", readFileSync(join(PROJ, "conflict.txt"), "utf8").includes("external"), readFileSync(join(PROJ, "conflict.txt"), "utf8").slice(0, 40));

// Wait for the recovery to finish (it runs before the window loads; the
// journal dirs are consumed or marked).
await sleep(3000);
const leftovers = existsSync(journalRoot) ? readdirSync(journalRoot) : [];
check("recovery removed the resolved journals", leftovers.length === 1 && leftovers[0].startsWith("recovery-3"), JSON.stringify(leftovers));
if (leftovers[0]) {
  const conflict = readFileSync(join(journalRoot, leftovers[0], "conflict.json"), "utf8");
  check("the conflict journal carries the marker", conflict.includes("conflict.txt"), conflict.slice(0, 120));
}

// The app still booted normally: a primary terminal exists.
const instances = await evalJs(`window.pi.getInstances().then((l) => l.map((i) => i.id))`);
check("the app booted with a terminal", Array.isArray(instances) && instances.includes("term-1"), JSON.stringify(instances));

// Sanity: the seeded hashes matched what the test launcher wrote.
check("before hash matches the seeded bytes", sha(readFileSync(greetingPath, "utf8")) === sha('export const greeting = "hello";\n'), "");

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
ws.close();
process.exit(passed === results.length ? 0 : 1);
