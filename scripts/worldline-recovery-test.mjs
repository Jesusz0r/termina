/**
 * Phase 5 e2e: promotion journal recovery at startup.
 *
 * Expects Electron on TERMINA_E2E_PORT with:
 *   TERMINA_INITIAL_CWD=<Git repo: greeting.ts "hello", other.txt "other">
 *   TERMINA_EVENTS_DIR=<clean dedicated dir>
 *   TERMINA_WORLDS_DIR=<worlds root pre-seeded by the launcher with:
 *     promotion-journal/recovery-1/  (phase applied, greeting.ts applied)
 *     promotion-journal/recovery-2/  (phase done — must not roll back)
 *     promotion-journal/recovery-3/  (phase applied with an external
 *                                     change — a recovery conflict)
 *     promotion-journal/recovery-4/  (legacy prepared, partially applied)
 *     promotion-journal/recovery-5/  (applying, partially applied)
 *     promotion-journal/recovery-6/  (legacy prepared with a conflict)
 *     promotion-journal/recovery-7/  (applied through an outside symlink)>
 *
 * Proves WORLDLINES §6.10 steps 10-11: startup recovery rolls back only
 * app-written bytes before the primary watcher starts; a "done" journal
 * leaves the source alone; an externally changed path keeps every version
 * and stops automatic recovery with a conflict marker.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { e2ePort } from "./e2e-port.mjs";

const port = e2ePort();
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
check("legacy prepared journal restored its partial write", readFileSync(join(PROJ, "prepared-first.txt"), "utf8") === "before-first\n");
check("legacy prepared journal left its untouched path alone", readFileSync(join(PROJ, "prepared-second.txt"), "utf8") === "before-second\n");
check("applying journal restored its partial write", readFileSync(join(PROJ, "applying-first.txt"), "utf8") === "before-first\n");
check("applying journal left its untouched path alone", readFileSync(join(PROJ, "applying-second.txt"), "utf8") === "before-second\n");
check("legacy prepared conflict kept the external bytes", readFileSync(join(PROJ, "prepared-conflict.txt"), "utf8") === "external\n");
const outside = `${PROJ}-outside`;
check("unsafe recovery left outside bytes untouched", readFileSync(join(outside, "touched.ts"), "utf8") === "applied-outside\n");
check("unsafe recovery did not create an outside file", !existsSync(join(outside, "missing.ts")));
check("corrupt before-image did not overwrite the applied bytes", readFileSync(join(PROJ, "corrupt-before.txt"), "utf8") === "applied\n");
check("external zero-byte file was not mistaken for a missing path", statSync(join(PROJ, "missing-vs-zero.txt")).isFile() && statSync(join(PROJ, "missing-vs-zero.txt")).size === 0);
check("rollback restored the symlink object", lstatSync(join(PROJ, "symlink-state")).isSymbolicLink() && readlinkSync(join(PROJ, "symlink-state")) === "greeting.ts");
check("rollback restored executable mode", (statSync(join(PROJ, "mode-state.sh")).mode & 0o777) === 0o755);
check("directory type conflict was left untouched", lstatSync(join(PROJ, "directory-conflict")).isDirectory());
check("a later journal recovered after the directory conflict", readFileSync(join(PROJ, "after-conflict.txt"), "utf8") === "before\n");
const missingBeforeExistsPath = join(PROJ, "missing-before-exists.txt");
check("journal missing beforeExists left the victim untouched", existsSync(missingBeforeExistsPath) && readFileSync(missingBeforeExistsPath, "utf8") === "applied\n");
const duplicatePath = join(PROJ, "duplicate-path.txt");
check("duplicate journal paths were rejected before mutation", existsSync(duplicatePath) && readFileSync(duplicatePath, "utf8") === "applied\n");
check("no-kind empty legacy record was rejected", statSync(join(PROJ, "ambiguous-empty.txt")).size === 0);
check("all paths were validated before the first mutation", readFileSync(join(PROJ, "schema-order.txt"), "utf8") === "applied\n");

// Wait for the recovery to finish (it runs before the window loads). Recovery
// intentionally retains every journal as evidence: the journal directory is
// attacker-replaceable between Node path checks, so startup never writes a
// marker into it or deletes it.
await sleep(3000);
const leftovers = existsSync(journalRoot) ? readdirSync(journalRoot).sort() : [];
const expectedJournals = Array.from({ length: 18 }, (_, index) => `recovery-${index + 1}`).sort();
check("recovery retained every journal as evidence", JSON.stringify(leftovers) === JSON.stringify(expectedJournals), JSON.stringify(leftovers));
for (const id of ["3", "6", "7", "8", "9", "10", "13", "15", "16", "17", "18"]) {
  check(`recovery did not write a conflict marker into journal ${id}`, !existsSync(join(journalRoot, `recovery-${id}`, "conflict.json")));
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
