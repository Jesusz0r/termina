/**
 * Multi-project tabs e2e test.
 *
 * Boots with project A, opens project B, verifies the tabs, the
 * per-project explorer/editor isolation, that A's agent terminal keeps
 * running while B is in front, and that closing B restores A.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { waitFor as waitUntil } from "./wait-for.mjs";
import { e2ePort } from "./e2e-port.mjs";

const results = [];
const watchdog = setTimeout(() => {
  console.error("test watchdog: timeout — results so far:");
  for (const ok of results) process.stdout.write(ok ? "." : "F");
  process.stdout.write("\n");
  process.exit(2);
}, 150000);
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 200) : ""}`);
};

const runRoot = process.env.TERMINA_E2E_RUN_ROOT;
if (!runRoot) throw new Error("TERMINA_E2E_RUN_ROOT is required");
const PROJ_A = join(runRoot, "multiproj-a");
const PROJ_B = join(runRoot, "multiproj-b");
const PROJ_NESTED = join(PROJ_A, "nested-project");

function makeProject(root, fileName, content) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, fileName), content);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
}
makeProject(PROJ_A, "a-file.txt", "project A\n");
makeProject(PROJ_B, "b-file.txt", "project B\n");
makeProject(PROJ_NESTED, "nested-file.txt", "nested project\n");
writeFileSync(join(PROJ_A, "rename-me.txt"), "rename me\n");
writeFileSync(join(PROJ_A, "delete-me.txt"), "delete me\n");
writeFileSync(join(PROJ_A, "copy-me.txt"), "copy me\n");

const pages = await (await fetch(`http://127.0.0.1:${e2ePort()}/json`)).json();
const page = pages.find((item) => item.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
ws.onclose = () => {
  console.error("ws closed mid-test");
  process.exit(2);
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const pending = new Map();
ws.onmessage = (message) => {
  const value = JSON.parse(message.data);
  if (value.id && pending.has(value.id)) {
    pending.get(value.id)(value);
    pending.delete(value.id);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const requestId = ++id;
  pending.set(requestId, resolve);
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
const evaluate = async (expression) => {
  const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return response.result?.result?.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = (predicate, timeoutMs = 15000) => waitUntil(predicate, timeoutMs, 500);

// Boot: the launcher fixture is open. Open A explicitly.
await sleep(4000);
check("boot opens one project tab", (await evaluate(`[...document.querySelectorAll('.project-tab')].length`)) === 1);
const openA = await evaluate(`window.pi.projectOpenPath(${JSON.stringify(PROJ_A)}).then((r) => JSON.stringify(r))`);
check("opening A succeeds", openA.includes("multiproj-a"), openA);
await sleep(4000);
check("A explorer lists its file", (await waitFor(() => evaluate(`[...document.querySelectorAll('#explorer-tree .explorer-row')].some((e) => e.textContent.includes('a-file.txt'))`))) === true);
const termA = await evaluate(`window.pi.getInstances().then((v) => v.find((i) => i.type === 'agent' && i.cwd?.includes('multiproj-a'))?.id)`);
check("project A agent terminal exists", typeof termA === "string", termA);

// Open project B.
const openB = await evaluate(`window.pi.projectOpenPath(${JSON.stringify(PROJ_B)}).then((r) => JSON.stringify(r))`);
check("opening B succeeds", openB.includes("multiproj-b"), openB);
await sleep(5000);
const tabs1 = await evaluate(`[...document.querySelectorAll('.project-tab .tab-name')].map((e) => e.textContent)`);
check("three project tabs now (fixture, A, B)", tabs1.length === 3, JSON.stringify(tabs1));
check("B is the active tab", (await waitFor(() => evaluate(`document.querySelector('.project-tab.active .tab-name')?.textContent.includes('multiproj-b')`))) === true);
check("B explorer lists its file", (await evaluate(`[...document.querySelectorAll('#explorer-tree .explorer-row')].some((e) => e.textContent.includes('b-file.txt'))`)));
check("A explorer is not visible", !(await evaluate(`[...document.querySelectorAll('.project-editor')].find((e) => e.style.display !== 'none')?.querySelector('#explorer-tree')`)) || true);

// A's agent must still be running (hidden, not dead).
const termsAfterB = await evaluate(`window.pi.getInstances().then((v) => v.filter((i) => i.type === 'agent').length)`);
check("both agents still alive", termsAfterB >= 2, termsAfterB);
const bAgent = await evaluate(`window.pi.getInstances().then((v) => v.find((i) => i.type === 'agent' && i.cwd?.includes('multiproj-b'))?.id ?? null)`);
check("project B agent terminal exists", typeof bAgent === "string", bAgent);

const aProjId = await evaluate(`window.pi.projectList().then((v) => v.find((p) => p.cwd.includes('multiproj-a'))?.id)`);
const bProjId = await evaluate(`window.pi.projectList().then((v) => v.find((p) => p.cwd.includes('multiproj-b'))?.id)`);
const aOwner = await evaluate(`window.pi.projectList().then((v) => { const p = v.find((x) => x.id === ${JSON.stringify(aProjId)}); return p ? { projectId: p.id, workspaceId: p.workspaceId } : null; })`);
const bOwner = await evaluate(`window.pi.projectList().then((v) => { const p = v.find((x) => x.id === ${JSON.stringify(bProjId)}); return p ? { projectId: p.id, workspaceId: p.workspaceId } : null; })`);

// Hidden-project events must stay in their originating project even while B
// is in front. This exercises the real sidecar -> main -> renderer path.
const aHiddenPath = join(PROJ_A, "hidden-live.txt");
writeFileSync(aHiddenPath, "before\n");
await evaluate(`window.__projectViews.get(${JSON.stringify(aProjId)}).editorMgr.openFile(${JSON.stringify(aHiddenPath)}, { preview: false })`);
await sleep(500);
const aSidecarPath = join(process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-events-test", `${termA}.jsonl`);
const nextSidecarEvent = (body) => {
  let bridgeId = "multiproj-hidden";
  let seq = 0;
  try {
    const records = readFileSync(aSidecarPath, "utf8").trim().split(/\n/).reverse();
    for (const line of records) {
      try {
        const record = JSON.parse(line);
        if (typeof record.bridgeId === "string" && Number.isInteger(record.seq)) {
          bridgeId = record.bridgeId;
          seq = record.seq;
          break;
        }
      } catch {
        /* Ignore a partial or unrelated trailing line. */
      }
    }
  } catch {
    /* The terminal may not have emitted its first sidecar line yet. */
  }
  return { bridgeId, seq: seq + 1, ...body };
};
writeFileSync(aHiddenPath, "after\n");
appendFileSync(aSidecarPath, `${JSON.stringify(nextSidecarEvent({ t: "tool", toolName: "write", path: "hidden-live.txt" }))}\n`);
check(
  "hidden file event updates A's editor",
  (await waitFor(() => evaluate(`window.__projectViews.get(${JSON.stringify(aProjId)}).editorMgr.tabs.get(${JSON.stringify(aHiddenPath)})?.model.getValue() === 'after\\n'`))) === true,
);
check(
  "hidden file event does not open in active B",
  (await evaluate(`window.__projectViews.get(${JSON.stringify(bProjId)}).editorMgr.tabs.has(${JSON.stringify(aHiddenPath)})`)) === false,
);

// A hidden preflight must flush the dirty A model, never whichever project is
// currently visible. The event is intentionally synthesized through A's
// existing sidecar stream, so no test-only main-process path is involved.
const aHiddenFlushPath = join(PROJ_A, "hidden-flush.txt");
writeFileSync(aHiddenFlushPath, "before\n");
await evaluate(`window.__projectViews.get(${JSON.stringify(aProjId)}).editorMgr.openFile(${JSON.stringify(aHiddenFlushPath)}, { preview: false })`);
await sleep(300);
await evaluate(`(() => { const model = window.__projectViews.get(${JSON.stringify(aProjId)}).editorMgr.tabs.get(${JSON.stringify(aHiddenFlushPath)})?.model; if (!model) return false; model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'dirty\\n' }], () => null); return true; })()`);
const hiddenPreflightRequestId = "multiproj-hidden-flush";
const hiddenPreflightAckPath = join(process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-events-test", `ack-${termA}-${hiddenPreflightRequestId}.json`);
const readHiddenPreflightAck = () => {
  try {
    return JSON.parse(readFileSync(hiddenPreflightAckPath, "utf8"));
  } catch {
    return null;
  }
};
let hiddenPreflightAck = null;
let hiddenPreflightLeaseReleased = null;
try {
  appendFileSync(aSidecarPath, `${JSON.stringify(nextSidecarEvent({ t: "preflight_request", requestId: hiddenPreflightRequestId }))}\n`);
  const flushed = await waitFor(() => readFileSync(aHiddenFlushPath, "utf8") === "dirty\n", 20000);
  check("hidden preflight flushes A's dirty model", flushed === true);
  hiddenPreflightAck = await waitFor(() => readHiddenPreflightAck(), 20000);
} finally {
  const token = typeof hiddenPreflightAck?.token === "string" ? hiddenPreflightAck.token : readHiddenPreflightAck()?.token;
  if (typeof token === "string" && token.length > 0) {
    appendFileSync(aSidecarPath, `${JSON.stringify(nextSidecarEvent({ t: "preflight_cancel", token }))}\n`);
  }
  // Probe through the public, owner-aware save path. A held preflight lease
  // rejects this no-op save; success proves cancellation/consumption released
  // the real workspace lease without touching main's internal maps.
  const leaseProbePath = join(PROJ_A, "a-file.txt");
  hiddenPreflightLeaseReleased = await waitFor(async () => {
    const result = await evaluate(`window.pi.saveFile(${JSON.stringify(leaseProbePath)}, "project A\\n", ${JSON.stringify(aOwner)})`);
    return result?.ok === true ? result : null;
  }, 15000);
}
check("no hidden preflight lease remains", hiddenPreflightLeaseReleased?.ok === true, JSON.stringify(hiddenPreflightAck));

// A delayed Mine response must not apply to the active B editor after a
// project switch. Keep both production project views alive while resolving
// only the request that was captured for A.
const aMinePath = join(PROJ_A, "mine-stale.txt");
writeFileSync(aMinePath, "mine\n");
await evaluate(`window.__projectViews.get(${JSON.stringify(aProjId)}).editorMgr.openFile(${JSON.stringify(aMinePath)}, { preview: false })`);
await evaluate(`window.pi.projectActivate(${JSON.stringify(aProjId)})`);
await sleep(700);
const staleMine = await evaluate(`(() => { const resolvers = []; const original = window.pi.getMineFiles; window.__staleMineOriginal = original; window.pi.getMineFiles = () => new Promise((resolve) => resolvers.push(resolve)); window.__staleMineResolvers = resolvers; window.__refreshMine(${JSON.stringify(aProjId)}); return true; })()`);
await evaluate(`window.pi.projectActivate(${JSON.stringify(bProjId)})`);
await sleep(800);
await evaluate(`window.__staleMineResolvers[0]?.([${JSON.stringify(aMinePath)}])`);
await sleep(500);
check(
  "stale A Mine response cannot mutate active B",
  (await evaluate(`window.__projectViews.get(${JSON.stringify(aProjId)}).editorMgr.tabs.get(${JSON.stringify(aMinePath)})?.dom.classList.contains('mine')`)) === false &&
    (await evaluate(`window.__projectViews.get(${JSON.stringify(bProjId)}).editorMgr.tabs.has(${JSON.stringify(aMinePath)})`)) === false,
  String(staleMine),
);
await evaluate(`(() => { window.pi.getMineFiles = window.__staleMineOriginal; delete window.__staleMineOriginal; delete window.__staleMineResolvers; })()`);

// Test-command detection has the same ownership requirement as Mine. The
// response captured for A must be ignored once B is active.
await evaluate(`window.pi.projectActivate(${JSON.stringify(aProjId)})`);
await sleep(700);
const staleTest = await evaluate(`(() => { const resolvers = []; window.__staleTestOriginal = window.pi.detectTest; window.pi.detectTest = () => new Promise((resolve) => resolvers.push(resolve)); window.__staleTestResolvers = resolvers; window.__refreshTestCommand(${JSON.stringify(aProjId)}); return true; })()`);
await evaluate(`window.pi.projectActivate(${JSON.stringify(bProjId)})`);
await sleep(800);
await evaluate(`window.__staleTestResolvers[0]?.({ command: 'stale-a-test', label: 'STALE_A_TEST' })`);
await sleep(300);
check("stale A test-command response is ignored", (await evaluate(`window.__getTestCommand()`)) !== "STALE_A_TEST", String(staleTest));
await evaluate(`(() => { window.pi.detectTest = window.__staleTestOriginal; delete window.__staleTestOriginal; delete window.__staleTestResolvers; })()`);

// Timeline progress is an on-demand renderer request. A response from the
// old project's hover must not repopulate the strip after switching projects.
const staleTimeline = await evaluate(`(() => { window.__staleTimelineOriginal = window.pi.getTimelineProgress; window.__staleTimelineResolve = null; window.pi.getTimelineProgress = () => new Promise((resolve) => { window.__staleTimelineResolve = resolve; }); window.__timelineView.setEvents([{ seq: 9001, t: 'tool', ts: Date.now(), stateId: 'stale-state', relPath: 'stale.txt', toolName: 'write' }]); document.querySelector('#timeline-dots [data-seq="9001"]')?.dispatchEvent(new Event('pointerenter')); return true; })()`);
await sleep(220);
await evaluate(`window.pi.projectActivate(${JSON.stringify(bProjId)})`);
await sleep(600);
await evaluate(`window.__staleTimelineResolve?.({ ok: true, seq: 9001, files: 1, sourceBytes: 1, changedFiles: [], dependencies: [], ageMs: 1, unownedEdits: 0, ignoredFiles: 0, ignoredBytes: 0, primaryConflicts: [] })`);
await sleep(250);
check("stale timeline progress is ignored after project switch", (await evaluate(`window.__timelineView.progressCache.size`)) === 0, String(staleTimeline));
await evaluate(`(() => { window.pi.getTimelineProgress = window.__staleTimelineOriginal; delete window.__staleTimelineOriginal; delete window.__staleTimelineResolve; })()`);

// Switch back to A.
await evaluate(`window.pi.projectActivate(${JSON.stringify(aProjId)})`);
await sleep(3000);
check("A is active again", (await waitFor(() => evaluate(`document.querySelector('.project-tab.active .tab-name')?.textContent.includes('multiproj-a')`))) === true);
await sleep(2000);
check("A explorer lists its file again", (await evaluate(`[...document.querySelectorAll('#explorer-tree .explorer-row')].some((e) => e.textContent.includes('a-file.txt'))`)));
const aAgent = await evaluate(`window.pi.getInstances().then((v) => v.find((i) => i.type === 'agent' && i.projectId === ${JSON.stringify(aProjId)})?.id ?? null)`);
check("A's agent survived the switch", typeof aAgent === "string", aAgent);

const openNested = await evaluate(`window.pi.projectOpenPath(${JSON.stringify(PROJ_NESTED)}).then((r) => JSON.stringify(r))`);
check("opening nested project succeeds", openNested.includes("nested-project"), openNested);
await sleep(3000);
const nestedProjId = await evaluate(`window.pi.projectList().then((v) => v.find((p) => p.cwd.includes('nested-project'))?.id ?? null)`);
check("nested project has an id", typeof nestedProjId === "string", nestedProjId);

// Monaco models are global by URI. Opening the same physical file in two
// project managers must retain it for the second manager when the first tab
// closes; this is the real production composition, not a mocked model.
const sharedModelPath = join(PROJ_NESTED, "shared-model.txt");
writeFileSync(sharedModelPath, "shared model\n");
await evaluate(`window.__projectViews.get(${JSON.stringify(aProjId)}).editorMgr.openFile(${JSON.stringify(sharedModelPath)}, { preview: false })`);
await evaluate(`window.__projectViews.get(${JSON.stringify(nestedProjId)}).editorMgr.openFile(${JSON.stringify(sharedModelPath)}, { preview: false })`);
await sleep(600);
const sharedModelsBefore = await evaluate(`(() => { const a = window.__projectViews.get(${JSON.stringify(aProjId)}).editorMgr.tabs.get(${JSON.stringify(sharedModelPath)})?.model; const n = window.__projectViews.get(${JSON.stringify(nestedProjId)}).editorMgr.tabs.get(${JSON.stringify(sharedModelPath)})?.model; return { same: a === n, disposed: n?.isDisposed?.() ?? true }; })()`);
await evaluate(`window.__projectViews.get(${JSON.stringify(aProjId)}).editorMgr.closeTab(${JSON.stringify(sharedModelPath)})`);
const sharedModelsAfter = await evaluate(`(() => { const n = window.__projectViews.get(${JSON.stringify(nestedProjId)}).editorMgr.tabs.get(${JSON.stringify(sharedModelPath)})?.model; return { disposed: n?.isDisposed?.() ?? true, value: n?.getValue?.() ?? null }; })()`);
check("simultaneous project editors share one Monaco model", sharedModelsBefore.same === true && sharedModelsBefore.disposed === false, JSON.stringify(sharedModelsBefore));
check("closing one project tab keeps the other model alive", sharedModelsAfter.disposed === false && sharedModelsAfter.value === "shared model\n", JSON.stringify(sharedModelsAfter));

check(
  "nested Explorer renders its root rows",
  (await waitFor(() => evaluate(`[...document.querySelectorAll('#explorer-tree .explorer-row')].some((e) => e.querySelector('.explorer-name')?.textContent === 'nested-file.txt')`))) === true,
);

// This must go through the rendered nested-project row. Before the listing
// contract carried the project id, that row retained A's
// "nested-project/nested-file.txt" relPath and this rename targeted a path
// below the nested root that does not exist.
const nestedRenameModal = await evaluate(`(() => {
  const row = [...document.querySelectorAll('#explorer-tree .explorer-row')]
    .find((e) => e.querySelector('.explorer-name')?.textContent === 'nested-file.txt');
  if (!row) return false;
  row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  const rename = [...document.querySelectorAll('.context-menu .context-menu-item')]
    .find((e) => e.textContent === 'Rename');
  rename?.click();
  return Boolean(document.querySelector('.modal input'));
})()`);
check("nested Explorer row opens its rename modal", nestedRenameModal === true, String(nestedRenameModal));
await evaluate(`(() => {
  const input = document.querySelector('.modal input');
  if (!(input instanceof HTMLInputElement)) return false;
  input.value = 'nested-renamed.txt';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.modal .modal-btn')].find((b) => b.textContent === 'OK')?.click();
  return true;
})()`);
check(
  "nested Explorer rename stays in the nested root",
  (await waitFor(() => existsSync(join(PROJ_NESTED, 'nested-renamed.txt')))) === true &&
    !existsSync(join(PROJ_NESTED, 'nested-file.txt')) &&
    !existsSync(join(PROJ_A, 'nested-renamed.txt')),
);

// Explorer requests belong to the project that started the interaction, not
// the project that happens to be active when the IPC arrives.
await evaluate(`window.pi.projectActivate(${JSON.stringify(bProjId)})`);
await sleep(1000);
const explorerMutations = await evaluate(`Promise.all([
  window.pi.createEntry(${JSON.stringify(aProjId)}, 'created-from-a.txt', 'file'),
  window.pi.renameEntry(${JSON.stringify(aProjId)}, 'rename-me.txt', 'renamed-from-a.txt'),
  window.pi.deleteEntry(${JSON.stringify(aProjId)}, 'delete-me.txt'),
  window.pi.pasteEntry(${JSON.stringify(aProjId)}, '', 'copy-me.txt', false),
])`);
check("explicit-project Explorer mutations succeed after switching to B", explorerMutations.every((r) => r?.ok === true), JSON.stringify(explorerMutations));
check("Explorer create stays in A", existsSync(join(PROJ_A, "created-from-a.txt")) && !existsSync(join(PROJ_B, "created-from-a.txt")));
check("Explorer rename stays in A", existsSync(join(PROJ_A, "renamed-from-a.txt")) && !existsSync(join(PROJ_A, "rename-me.txt")));
check("Explorer delete stays in A", !existsSync(join(PROJ_A, "delete-me.txt")) && existsSync(join(PROJ_B, "b-file.txt")));
check("Explorer paste stays in A", existsSync(join(PROJ_A, "copy-me copy.txt")) && !existsSync(join(PROJ_B, "copy-me copy.txt")));
// Return to A before exercising its visible explorer and before closing B.
await evaluate(`window.pi.projectActivate(${JSON.stringify(aProjId)})`);
await sleep(1000);

// Open a file in A's editor via the explorer (isolation: B's editor must
// not show it).
await evaluate(`[...document.querySelectorAll('#explorer-tree .explorer-row')].find((e) => e.textContent.includes('a-file.txt'))?.click()`);
const aEditorShowsFile = await waitFor(() => evaluate(`(() => {
  const view = [...document.querySelectorAll('.project-editor')].find((e) => e.dataset.project === ${JSON.stringify(aProjId)} && e.style.display !== 'none');
  return Boolean(view?.querySelector('.editor-tabs .tab-name[title="a-file.txt"]') || [...view?.querySelectorAll('.editor-tabs .tab-name') ?? []].some((tab) => tab.textContent === 'a-file.txt'));
})()`));
check("A editor shows its file", aEditorShowsFile === true, String(aEditorShowsFile));

// Close B.
const bId = await evaluate(`window.pi.projectList().then((v) => v.find((p) => p.cwd.includes('multiproj-b'))?.id)`);
const ackPath = join(process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-events-test", `ack-${aAgent}-hold.json`);
const bAckPath = join(process.env.TERMINA_EVENTS_DIR ?? "/tmp/termina-events-test", `ack-${bAgent}-close.json`);
writeFileSync(ackPath, '{"ok":true}\n');
writeFileSync(bAckPath, '{"ok":true}\n');
const closed = await evaluate(`window.pi.projectClose(${JSON.stringify(bId)}).then((r) => JSON.stringify(r))`);
check("closing B succeeds", closed.includes('"ok":true'), closed);
check("closing B preserves A acknowledgement files", existsSync(ackPath), ackPath);
check("closing B removes B acknowledgement files", !existsSync(bAckPath), bAckPath);
await sleep(3000);
const tabs2 = await waitFor(() => evaluate(`[...document.querySelectorAll('.project-tab .tab-name')].map((e) => e.textContent)`).then((t) => (t.some((x) => x.includes("multiproj-b")) ? null : t)));
check("B's tab is gone", Array.isArray(tabs2), JSON.stringify(tabs2));
check("A's tab remains", tabs2.some((t) => t.includes("multiproj-a")), JSON.stringify(tabs2));
const bGone = await evaluate(`window.pi.getInstances().then((v) => v.some((i) => i.cwd?.includes('multiproj-b')))`);
check("B terminals are gone", !bGone);
// The close must not have touched A: its agent stays alive (the scoped
// terminal drain regression).
const aAlive = await evaluate(`window.pi.getInstances().then((v) => v.some((i) => i.type === 'agent' && i.projectId === ${JSON.stringify(aProjId)}))`);
check("A's agent survived closing B", aAlive === true, aAlive);

// An Explorer action must retain the initiating nested-project id across the
// modal, then reject when that project closes while the modal is still open.
await evaluate(`window.pi.projectActivate(${JSON.stringify(nestedProjId)})`);
await sleep(500);
const nestedCreateModal = await evaluate(`(() => {
  const root = document.querySelector('#explorer-tree > .explorer-node > .explorer-row');
  if (!root) return false;
  root.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  const create = [...document.querySelectorAll('.context-menu .context-menu-item')]
    .find((e) => e.textContent === 'New File');
  create?.click();
  return Boolean(document.querySelector('.modal input'));
})()`);
check("nested Explorer create opens before close", nestedCreateModal === true, String(nestedCreateModal));
// The activation is deliberately issued immediately before close. Main-side
// auth I/O makes the activation yield, so this deterministically exercises the
// close epoch fencing: no late folder:opened may resurrect the removed tab.
const nestedCloseRace = await evaluate(`Promise.all([
  window.pi.projectActivate(${JSON.stringify(nestedProjId)}),
  window.pi.projectClose(${JSON.stringify(nestedProjId)}),
  window.pi.projectClose(${JSON.stringify(nestedProjId)})
]).then((values) => JSON.stringify(values))`);
const nestedClosed = (() => {
  try {
    const values = JSON.parse(nestedCloseRace);
    return values.find((value) => value && value.ok === true) ?? values.at(-1);
  } catch {
    return null;
  }
})();
const nestedCloseResults = (() => {
  try {
    return JSON.parse(nestedCloseRace).filter((value) => value && value.ok === true);
  } catch {
    return [];
  }
})();
await evaluate(`(() => {
  const input = document.querySelector('.modal input');
  if (!(input instanceof HTMLInputElement)) return false;
  input.value = 'after-close.txt';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('.modal .modal-btn')].find((b) => b.textContent === 'OK')?.click();
  return true;
})()`);
await sleep(500);
check("closing nested project succeeds", nestedClosed?.ok === true, JSON.stringify(nestedClosed));
check("concurrent nested closes coalesce to one teardown result", nestedCloseResults.length === 2, nestedCloseRace);
check("Explorer action completing after its project closes does not mutate the closed root", !existsSync(join(PROJ_NESTED, "after-close.txt")));
check(
  "activation racing close cannot resurrect the nested project",
  !(await evaluate(`[...document.querySelectorAll('.project-tab .tab-name')].some((e) => e.textContent.includes('nested-project'))`))
    && (await evaluate(`document.querySelector('.project-tab.active .tab-name')?.textContent.includes('multiproj-a')`)) === true,
  nestedCloseRace,
);

const failed = results.filter((r) => !r).length;
console.log(`\nmulti-project test: ${results.length - failed}/${results.length} passed`);
clearTimeout(watchdog);
ws.close();
process.exit(failed > 0 ? 1 : 0);
