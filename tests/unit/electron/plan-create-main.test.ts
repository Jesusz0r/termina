import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { planCreationError } from "../../../electron/plan-board.ts";
import { appendPlanTask } from "../../../electron/main/plan-create.ts";
import { parsePlanTaskCreateRequest } from "../../../electron/main/ipc-validate.ts";
import type { PlanTask, PlanTaskCreateRequest, PlanTaskCreateResult } from "../../../shared/types.ts";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const names = ["createPlanTask", "planCreationError", "planOwnerFacts", "projectOfTerminal", "workspaceOfTerminal", "projectIsSwitching"];
const methods: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && names.includes(node.name.getText(source))) methods.push(node.getText(source));
  ts.forEachChild(node, visit);
}
visit(source);
if (methods.length !== names.length) throw new Error("Missing main plan creation method");
const compiled = ts.transpile(`class Main { ${methods.join("\n")} } return new Main();`, { target: ts.ScriptTarget.ES2022 });
function fixture() {
  const workspace = { id: "ws", root: "/actual/root", primary: true, generation: 9, terminalIds: new Set(["term-1"]) };
  const project = { id: "background", cwd: "/displayed/root", workspaces: new Map([[workspace.id, workspace]]), terminalIds: new Set(["term-1"]) };
  const inst = { id: "term-1", generation: 2, projectId: project.id, workspaceId: workspace.id, cwd: workspace.root,
    type: "agent", persist: true, busy: false, closed: false, pty: { hasExited: false }, plan: [] as PlanTask[] };
  const main = new Function("parsePlanTaskCreateRequest", "planCreationError", "appendPlanTask", "isPtyRendererSendTargetCurrent", compiled)(
    parsePlanTaskCreateRequest, planCreationError, appendPlanTask, (a: unknown, b: unknown) => a === b,
  ) as { createPlanTask(value: unknown): Promise<PlanTaskCreateResult> };
  const target = {};
  const save = vi.fn(); const send = vi.fn();
  const canonicalize = vi.fn(async (path: string) => path);
  const state = { projects: new Map([[project.id, project]]), runtime: new Map([[inst.id, inst]]),
    switchingProjects: new Set<string>(), projectClosePromises: new Map(), terminalCloseRequests: new WeakMap(),
    dispatchWorkers: new Map(), disposed: false, activeProjectId: "different-project", captureRendererSendTarget: () => target,
    canonicalPath: canonicalize, savePlanRoster: save, sendPlan: send };
  Object.assign(main, state);
  const request: PlanTaskCreateRequest = { owner: { projectId: project.id, workspaceId: workspace.id,
    root: workspace.root, terminalId: inst.id, generation: inst.generation }, projectRoot: project.cwd, text: "Fix /actual/root/file.ts" };
  return { main, state, project, workspace, inst, request, save, send, canonicalize };
}

describe("main manual task ownership fences", () => {
  it("appends and persists on a background project without activation", async () => {
    const f = fixture();
    expect(await f.main.createPlanTask(f.request)).toMatchObject({ ok: true, task: { state: "pending", paths: ["file.ts"] } });
    expect(f.state.activeProjectId).toBe("different-project");
    expect(f.save).toHaveBeenCalledExactlyOnceWith(f.inst);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.inst.plan).toHaveLength(1);
  });
  it.each(["generation", "root", "project-root", "owner-generation", "workspace-id", "busy", "closing", "disposed", "plan-replaced", "worker"])(
    "rejects %s changing during path derivation without persistence or execution", async (change) => {
      const f = fixture();
      f.canonicalize.mockImplementation(async (path) => {
        switch (change) {
          case "generation": f.workspace.generation++; break;
          case "root": f.workspace.root = "/changed"; break;
          case "project-root": f.project.cwd = "/changed"; break;
          case "owner-generation": f.inst.generation++; break;
          case "workspace-id": f.inst.workspaceId = "other"; break;
          case "busy": f.inst.busy = true; break;
          case "closing": f.state.switchingProjects.add(f.project.id); break;
          case "disposed": Object.assign(f.main, { disposed: true }); break;
          case "plan-replaced": f.inst.plan = []; break;
          case "worker": f.state.dispatchWorkers.set(f.inst.id, {}); break;
        }
        return path;
      });
      expect(await f.main.createPlanTask(f.request)).toMatchObject({ ok: false });
      expect(f.inst.plan).toEqual([]);
      expect(f.save).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    });
  it.each(["displayed-root", "actual-root", "project", "terminal", "generation"])("rejects incorrect requested %s before awaits", async (change) => {
    const f = fixture();
    switch (change) {
      case "displayed-root": f.request.projectRoot = f.workspace.root; break;
      case "actual-root": f.request.owner.root = f.project.cwd; break;
      case "project": f.request.owner.projectId = "other"; break;
      case "terminal": f.request.owner.terminalId = "term-2"; break;
      case "generation": f.request.owner.generation++; break;
    }
    expect(await f.main.createPlanTask(f.request)).toMatchObject({ ok: false });
    expect(f.canonicalize).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
});
