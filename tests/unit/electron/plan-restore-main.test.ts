import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { parsePlanModelMarker } from "../../../electron/plan-board.ts";
import { rosterFilePath } from "../../../electron/roster-store.ts";
import { parseTerminalRoster } from "../../../electron/terminal-roster.ts";
import { sanitizeSessionDir } from "../../../electron/main/project-workspace.ts";
import type { PlanTask } from "../../../shared/types.ts";

// Exercise the production restore caller as well as the canonical disk parser.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let method: ts.MethodDeclaration | undefined;
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(source) === "restoreProjectTerminals") method = node;
  ts.forEachChild(node, visit);
}
visit(source);
if (!method) throw new Error("Missing production terminal restore method");
const compiled = ts.transpile(`class Main { ${method.getText(source)} } return new Main();`, { target: ts.ScriptTarget.ES2022 });

function fixture(raw: unknown) {
  const runtime = new Map<string, { id: string; persist: boolean; plan: PlanTask[] }>();
  const loaded = parseTerminalRoster(raw);
  const main = new Function("rosterFilePath", "sanitizeSessionDir", "parsePlanModelMarker", compiled)(rosterFilePath, sanitizeSessionDir, parsePlanModelMarker);
  const createUserTerminal = vi.fn(async (opts: { id: string }) => {
    const independent = opts.id === "term-2";
    const inst = { id: independent ? "term-4" : opts.id, persist: !independent, plan: [] as PlanTask[] };
    runtime.set(inst.id, inst);
    return inst;
  });
  const project = { id: "project", canonicalRoot: "/actual/root", cwd: "/actual/root", unrestoredTerminals: [],
    worldlines: { candidateContextOf: (id: string) => id === "term-4" ? { sourceRunId: null } : null } };
  const sendPlan = vi.fn();
  const saveTerminalRoster = vi.fn();
  Object.assign(main, { userDataDir: "/user-data", runtime: { get: (id: string) => runtime.get(id), loadRoster: async () => ({ entries: loaded, exists: true }) },
    noteTerminalId: vi.fn(), createUserTerminal, primaryWorkspace: () => ({ id: "primary" }), sendPlan, saveTerminalRoster });
  return { main, project, runtime, loaded, sendPlan, saveTerminalRoster, createUserTerminal };
}

describe("production Plan Board restore", () => {
  it("retains the independent result link after restart and drops only live assignment fields", async () => {
    const candidate = { comparisonId: "cmp-12", label: "A" };
    const f = fixture([{ id: "term-1", type: "agent", plan: [
      { text: "Finished task", paths: ["done.ts"], state: "done", candidate,
        dispatchResult: { workerId: "term-9", outcome: "completed" }, workerId: "term-9", claimed: ["done.ts"] },
      { text: "Interrupted task @model provider/task", paths: ["pending.ts"], state: "active", candidate,
        dispatchResult: { workerId: "term-10", outcome: "incomplete" }, workerId: "term-11", claimed: [] },
    ] }]);
    await f.main.restoreProjectTerminals(f.project);
    expect(f.runtime.get("term-1")?.plan).toEqual([
      { text: "Finished task", paths: ["done.ts"], state: "done", candidate,
        dispatchResult: { workerId: "term-9", outcome: "completed" } },
      { text: "Interrupted task @model provider/task", paths: ["pending.ts"], state: "pending", candidate,
        dispatchResult: { workerId: "term-10", outcome: "incomplete" }, model: "provider/task" },
    ]);
    expect(f.runtime.get("term-1")?.plan[0]?.candidate).not.toBe(f.loaded[0]?.plan?.[0]?.candidate);
    expect(f.sendPlan).toHaveBeenCalledExactlyOnceWith(f.runtime.get("term-1"));
    expect(f.saveTerminalRoster).toHaveBeenCalledExactlyOnceWith(f.project);
    expect(f.project.unrestoredTerminals).toEqual([]);
  });

  it("restores a migrated second owner's real board onto the canonical new terminal id", async () => {
    const first = { text: "Primary task", paths: ["first.ts"], state: "pending" };
    const second = { text: "Separate owner's task", paths: ["second.ts"], state: "done",
      candidate: { comparisonId: "cmp-2", label: "B" } };
    const f = fixture([{ id: "term-1", type: "agent", plan: [first] }, { id: "term-2", type: "agent", plan: [second] }]);
    await f.main.restoreProjectTerminals(f.project);
    expect(f.runtime.get("term-1")?.plan).toEqual([first]);
    expect(f.runtime.get("term-4")?.plan).toEqual([second]);
    expect(f.runtime.has("term-2")).toBe(false);
    expect(f.runtime.get("term-4")?.persist).toBe(false);
    expect(f.project.unrestoredTerminals).toEqual([]);
    expect(f.sendPlan).toHaveBeenCalledTimes(2);
  });
});
