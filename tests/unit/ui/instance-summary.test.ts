import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyInstanceSummary, handleWorldlineInstances, type WorldlineInstancePane } from "../../../src/worldline-project-state.ts";
import type { InstanceSummary } from "../../../shared/types.ts";

function pane(id: string): WorldlineInstancePane {
  return {
    instanceId: id,
    projectId: null,
    worldlineLabel: null,
    testCommand: null,
    candidateTestEpoch: 0,
    cwd: null,
    workspaceId: "",
    busy: false,
    type: "shell",
    engine: undefined,
    shellName: undefined,
    dispatchWorker: false,
    dispatchTask: undefined,
    modified: [],
    recorderState: "paused",
    recorderDetail: null,
    verify: { state: "untested", command: null, summary: null },
    model: null,
    thinkingLevel: null,
    usage: null,
  };
}

function summary(overrides: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    id: "term-1",
    generation: 2,
    cwd: "/proj",
    busy: true,
    type: "agent",
    engine: "core",
    workspaceId: "ws-primary",
    projectId: "proj-1",
    modified: [{ path: "/proj/a.ts", relPath: "a.ts", status: "modified" }],
    recorderState: "ready",
    recorderDetail: "ok",
    verify: { state: "pass", command: "pnpm test", summary: "green" },
    model: "test-model",
    thinkingLevel: "high",
    usage: "1k",
    ...overrides,
  };
}

describe("applyInstanceSummary (issue #276)", () => {
  it("copies required main-owned fields without inventing engine or recorder defaults", () => {
    const target = pane("term-1");
    const engines: Array<InstanceSummary["engine"]> = [];
    applyInstanceSummary(target, summary({ engine: undefined, type: "shell", recorderDetail: "degraded: disk" }), {
      setEngine: (_pane, engine) => engines.push(engine),
    });
    expect(target.engine).toBeUndefined();
    expect(engines).toEqual([undefined]);
    expect(target.modified).toEqual([{ path: "/proj/a.ts", relPath: "a.ts", status: "modified" }]);
    expect(target.recorderState).toBe("ready");
    expect(target.recorderDetail).toBe("degraded: disk");
    expect(target.workspaceId).toBe("ws-primary");
    expect(target.dispatchWorker).toBe(false);
  });

  it("is the single hydration path for roster pushes", () => {
    const panes = new Map<string, WorldlineInstancePane>();
    handleWorldlineInstances([summary()], {
      paneById: (id) => panes.get(id),
      createPane: (id) => {
        const created = pane(id);
        panes.set(id, created);
        return created;
      },
      updatePaneTab: () => {},
      setEngine: (target, engine) => {
        target.engine = engine;
      },
    });
    const hydrated = panes.get("term-1")!;
    expect(hydrated.recorderState).toBe("ready");
    expect(hydrated.recorderDetail).toBe("ok");
    expect(hydrated.modified).toHaveLength(1);
    expect(hydrated.engine).toBe("core");
  });

  it("is the only InstanceSummary mapper and lock uses the main-owned workspace id", () => {
    const main = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
    const projectState = readFileSync(new URL("../../../src/worldline-project-state.ts", import.meta.url), "utf8");
    expect(projectState).toContain("export function applyInstanceSummary");
    expect(projectState).toContain("applyInstanceSummary(pane, summary, bindings)");
    expect(main).toContain("applyInstanceSummary(pane, inst,");
    expect(main).toContain("handleWorldlineInstances(list,");
    expect(main).not.toContain("worldlinesView.labelOfTerminal(p.instanceId) === null");
    expect(main).toContain("p.workspaceId === view.workspaceId");
    expect(main).not.toContain('engine: instance.engine ?? "core"');
    expect(main).not.toContain("modified: instance.modified ?? []");
    expect(main).not.toContain('recorderState: instance.recorderState ?? "paused"');
    expect(main).toContain("pane.fromRoster = false");
    expect(main).toContain("if (liveIds.has(id) || !pane.fromRoster) continue");
  });
});
