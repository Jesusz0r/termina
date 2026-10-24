import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

// Exercise main's actual orchestration without importing Electron or spawning a PTY.
const source = ts.createSourceFile("main.ts", readFileSync(join(process.cwd(), "electron/main.ts"), "utf8"), ts.ScriptTarget.ES2022, true);
const members = source.statements.filter(ts.isClassDeclaration).flatMap((node) => [...node.members]);
function factory(name: string): string {
  const method = members.find((node) => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  if (!method) throw new Error(`missing main ${name}`);
  return ts.transpileModule(`return new (class { ${method.getText(source)} })();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

interface Creator {
  createTerminal(cwd: string | undefined, options: Record<string, unknown>): Promise<unknown>;
}

function creationHarness() {
  const workspace = { id: "source-ws", root: "/source/actual-tree", primary: true };
  const owner = { id: "source-project", cwd: "/source", workspaces: new Map([[workspace.id, workspace]]) };
  const stoppedAtSpawn = new Error("observed spawn boundary");
  const spawn = vi.fn(() => { throw stoppedAtSpawn; });
  const actor = new Function("process", "coreEngineBinary", "thinkingStartupArgs", "cleanEnv", "sessionBundleHasContent", "randomUUID", "MAX_TERMINAL_ROSTER", factory("createTerminal"))(
    { execPath: "/test/node" }, () => "/test/agent-core.mjs", () => [], () => ({}), () => false, () => "new-session", 32,
  ) as Creator;
  const host = Object.assign(actor, {
    projects: new Map([[owner.id, owner]]),
    runtime: { has: () => false, spawn },
    projectOfWorkspace: () => owner,
    project: () => { throw new Error("must not consult active background project"); },
    terminalCwd: vi.fn(() => "/active-background"),
    captureRendererSendTarget: () => null,
    noteTerminalId: vi.fn(),
    preferences: { showThinking: false },
    usableAgentThinking: () => null,
    usableAgentModel: () => null,
    copiedCoreModel: () => null,
    rememberedAgentSettings: () => null,
    coreProjectSessionDir: vi.fn(async (root: string) => `${root}/sessions`),
    reclaimUnusedEmptyCoreSessions: vi.fn(async () => {}),
    coreSessionFile: vi.fn(async (_id: string, root: string) => `${root}/sessions/current.jsonl`),
    sessionFileInUse: () => false,
    tailer: {},
  });
  return { host, workspace, spawn, stoppedAtSpawn };
}

describe("terminal creation source ownership", () => {
  it.each([false, true])("starts in the requested workspace, not the active project (persist=%s)", async (persist) => {
    const { host, workspace, spawn, stoppedAtSpawn } = creationHarness();
    await expect(host.createTerminal(undefined, {
      id: "term-worker", type: "agent", workspaceId: workspace.id, persist,
    })).rejects.toBe(stoppedAtSpawn);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: workspace.root, workspaceId: workspace.id }));
    expect(host.terminalCwd).not.toHaveBeenCalled();
    if (persist) {
      expect(host.coreProjectSessionDir).toHaveBeenCalledWith(workspace.root);
      expect(host.coreSessionFile).toHaveBeenCalledWith("core-new-session", workspace.root);
    }
  });

  it("keeps the explicit candidate launch root", async () => {
    const { host, workspace, spawn, stoppedAtSpawn } = creationHarness();
    await expect(host.createTerminal("/candidate/explicit-tree", {
      id: "term-candidate", type: "agent", workspaceId: workspace.id,
      launch: { cmd: "/test/sandbox-exec", args: [], env: {} },
    })).rejects.toBe(stoppedAtSpawn);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/candidate/explicit-tree" }));
    expect(host.terminalCwd).not.toHaveBeenCalled();
  });
});

interface Flusher {
  flushDirtyModels(writer: string, workspace: string): Promise<{ ok: boolean; failed: string[] }>;
}

describe("editor flush workspace ownership", () => {
  it("does not request a nonexistent editable candidate view", async () => {
    const actor = new Function(factory("flushDirtyModels"))() as Flusher;
    const send = vi.fn();
    Object.assign(actor, {
      projectOfWorkspace: () => ({ workspaces: new Map([["candidate-ws", { primary: false }]]) }),
      send,
    });
    expect(await actor.flushDirtyModels("preflight:term-candidate", "candidate-ws")).toEqual({ ok: true, failed: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it("still requests and waits for the primary editor flush", async () => {
    const actor = new Function("randomUUID", factory("flushDirtyModels"))(() => "request") as Flusher;
    const waiters = new Map<string, { timer: ReturnType<typeof setTimeout>; resolve: (value: { ok: boolean; failed: string[] }) => void }>();
    const send = vi.fn((_event: string, payload: { requestId: string }) => {
      const waiter = waiters.get(payload.requestId)!;
      clearTimeout(waiter.timer);
      waiters.delete(payload.requestId);
      waiter.resolve({ ok: true, failed: [] });
      return true;
    });
    Object.assign(actor, {
      projectOfWorkspace: () => ({ id: "source-project", workspaces: new Map([["primary-ws", { primary: true }]]) }),
      flushWaiters: waiters, send,
    });
    expect(await actor.flushDirtyModels("writer", "primary-ws")).toEqual({ ok: true, failed: [] });
    expect(send).toHaveBeenCalledWith("editor:flush-request", {
      requestId: "flush-request", writerId: "writer", projectId: "source-project", workspaceId: "primary-ws",
    }, undefined);
    expect(waiters.size).toBe(0);
  });

  it("still rejects an unowned workspace", async () => {
    const actor = new Function(factory("flushDirtyModels"))() as Flusher;
    Object.assign(actor, { projectOfWorkspace: () => null });
    expect(await actor.flushDirtyModels("writer", "closed-ws")).toEqual({
      ok: false, failed: ["workspace is no longer owned by a project"],
    });
  });
});
