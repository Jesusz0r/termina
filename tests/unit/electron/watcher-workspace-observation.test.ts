import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";
import { watchContentIdentity } from "../../../electron/watcher.ts";
import { evictOldest } from "../../../shared/evict-oldest.ts";

const source = ts.createSourceFile("main.ts", readFileSync(join(process.cwd(), "electron/main.ts"), "utf8"), ts.ScriptTarget.ES2022, true);
let callback: ts.Expression | undefined;
function walk(node: ts.Node): void {
  if (ts.isBinaryExpression(node) && node.left.getText(source) === "watcher.onChange") callback = node.right;
  ts.forEachChild(node, walk);
}
walk(source);
if (!callback) throw new Error("missing canonical watcher onChange callback");
const factory = ts.transpileModule(`return function(ws, canonicalRootPromise, workspaceTerminals) {
  return (${callback.getText(source)});
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

interface Workspace {
  id: string;
  root: string;
  generation: number;
  changeLines: Map<string, number[]>;
}
interface Change {
  path: string;
  content: string;
  status: "modified";
}
const makeHandler = new Function("relative", "isAbsolute", "watchContentIdentity", "evictOldest", "TerminaApp", "MAX_LIVE_SYNC_BYTES", "Buffer", factory)(
  relative, isAbsolute, watchContentIdentity, evictOldest, { LAST_WATCH_MAX: 100 }, 1024, Buffer,
) as (this: unknown, ws: Workspace, canonicalRoot: Promise<string>, terminals: () => never[]) => (change: Change) => Promise<void>;

function harness() {
  const send = vi.fn();
  const host = {
    captureRendererSendTarget: () => null,
    projectOfWorkspace: () => ({ id: "project" }),
    projectIsSwitching: () => false,
    canonicalPath: async (path: string) => path,
    pathIndex: { noteAdded: vi.fn() },
    markCandidateEvidenceStale: vi.fn(),
    lastWatchChange: new Map(),
    scheduleProjectSnapshot: vi.fn(),
    verifyRuns: new Map(),
    recordUserEdit: vi.fn(),
    send,
  };
  const old: Workspace = { id: "old-workspace", root: "/candidate", generation: 0, changeLines: new Map() };
  const reopened: Workspace = { ...old, id: "reopened-workspace", changeLines: new Map() };
  const observe = (ws: Workspace) => makeHandler.call(host, ws, Promise.resolve(ws.root), () => []);
  return { old, reopened, send, observe };
}

describe("watcher source notifications across candidate reopen", () => {
  it.each([false, true])("notifies each workspace once for the same physical write (new first=%s)", async (newFirst) => {
    const { old, reopened, send, observe } = harness();
    const change: Change = { path: "/candidate/hello.txt", content: "new contents\n", status: "modified" };
    const workspaces = newFirst ? [reopened, old] : [old, reopened];
    for (const ws of workspaces) await observe(ws)(change);
    // Native duplicates within one workspace still do not fabricate another transition.
    for (const ws of workspaces) await observe(ws)(change);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.map((call) => call[1].workspaceId)).toEqual(workspaces.map((ws) => ws.id));
    expect(old.generation).toBe(1);
    expect(reopened.generation).toBe(1);
  });
});
