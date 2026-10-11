import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { FolderOpenedPayload, TerminaBridge, WorkSummaryAction } from "../../../shared/types.ts";
import { activateProjectContext } from "../../../src/main/project-activation.ts";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functions = ["activateProjectPane", "createProjectTerminal"].map((name) => source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source));
const code = ts.transpileModule(`${functions.join("\n")}\nreturn {
  display: activateProjectPane, create: createProjectTerminal,
  active: () => activeId,
  switchProject: (id, generation) => { activeProjectId = id; activeProjectGeneration = generation; },
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(target: FolderOpenedPayload["terminal"] = { id: "term-2", generation: 7 }) {
  const first = { instanceId: "term-1", generation: 4, projectId: "p1", workspaceId: "primary" };
  const second = { instanceId: "term-2", generation: 7, projectId: "p1", workspaceId: "primary" };
  const panes = new Map([[first.instanceId, first], [second.instanceId, second]]);
  const createTerminal = vi.fn<TerminaBridge["createTerminal"]>().mockResolvedValue({ ok: true, id: "term-3" });
  const bindings = {
    panes, projectViews: new Map([["p1", { workspace: { id: "primary" } }]]),
    projectTerminalTarget: target, activeProjectId: "p1", activeProjectGeneration: 3, activeId: target ? "term-1" : null,
    showPane: vi.fn(), syncPaneVisibility: vi.fn(), renderChrome: vi.fn(),
    window: { termina: { createTerminal } }, activatePaneWhenReady: vi.fn(),
  };
  const view = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as {
    display(): void;
    create(type: "agent" | "shell", shell?: string): Promise<{ ok: boolean; error?: string }>;
    active(): string | null;
    switchProject(id: string | null, generation: number): void;
  };
  return { first, second, view, createTerminal, ...bindings };
}

describe("renderer main-admitted project terminal", () => {
  it("displays exactly the main target without another privileged selection or renderer priority", () => {
    const h = harness(); h.view.display();
    expect(h.showPane).toHaveBeenCalledExactlyOnceWith(h.second);
    expect(h.renderChrome).not.toHaveBeenCalled();
    expect(h.createTerminal).not.toHaveBeenCalled();
  });

  it.each(["no target", "missing target", "recycled generation", "other project", "other workspace"])("never substitutes another pane for %s", (reason) => {
    const h = harness(reason === "no target" ? null : { id: "term-2", generation: 7 });
    if (reason === "missing target") h.panes.delete(h.second.instanceId);
    if (reason === "recycled generation") h.second.generation = 8;
    if (reason === "other project") h.second.projectId = "p2";
    if (reason === "other workspace") h.second.workspaceId = "candidate";
    h.view.display();
    expect(h.view.active()).toBeNull(); expect(h.showPane).not.toHaveBeenCalled();
    expect(h.syncPaneVisibility).toHaveBeenCalledOnce(); expect(h.renderChrome).toHaveBeenCalledOnce();
    expect(h.createTerminal).not.toHaveBeenCalled();
  });

  it("waits for an exact roster identity when the folder arrives before its pane", () => {
    const h = harness(); h.panes.delete(h.second.instanceId); h.view.display();
    expect(h.showPane).not.toHaveBeenCalled();
    h.panes.set(h.second.instanceId, h.second); h.view.display();
    expect(h.showPane).toHaveBeenCalledExactlyOnceWith(h.second);
  });
});

describe("renderer entry intent and Attention navigation lifecycle", () => {
  function navigationHarness() {
    const declaration = source.statements.filter(ts.isVariableStatement).flatMap((node) => [...node.declarationList.declarations])
      .find((node) => node.name.getText(source) === "attentionView")!;
    const properties = ((declaration.initializer as ts.CallExpression).arguments[0] as ts.ObjectLiteralExpression).properties;
    const navigate = (properties.find((node) => node.name?.getText(source) === "onNavigate") as ts.PropertyAssignment).initializer;
    const helpers = ["activateProject", "enterProject"].map((name) => source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source));
    const compiled = ts.transpileModule(`${helpers.join("\n")}\nreturn { enter: enterProject, navigate: ${navigate.getText(source)} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const folder: FolderOpenedPayload = { projectId: "p1", projectRoot: "/p1", cwd: "/p1", workspaceId: "primary",
      primaryWorkspaceId: "primary", activationGeneration: 1, terminal: null, needsLogin: false };
    let current = true;
    const projectActivate = vi.fn<TerminaBridge["projectActivate"]>().mockResolvedValue({ ok: true, folder });
    const bindings = {
      activateProjectContext, window: { termina: { projectActivate } }, ensureEditorModule: vi.fn().mockResolvedValue(undefined),
      applyFolderOpened: vi.fn(), projectViews: new Map([["p1", {}]]), activeProjectId: "p1",
      latestProjectActivationGeneration: 1, appliedProjectFolder: folder,
      attentionView: { cancelNavigation: vi.fn(() => { current = false; }) }, layout: { revealTerminal: vi.fn() },
      navigateWorkAction: vi.fn().mockResolvedValue(true),
    };
    const navigation = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings)) as {
      enter(id: string): Promise<boolean>;
      navigate(id: string, action: WorkSummaryAction | null, isCurrent: () => boolean): Promise<boolean>;
    };
    return { navigation, projectActivate, current: () => current, ...bindings };
  }

  it("lets Attention own its navigation token so automatic entry does not invalidate it", async () => {
    const h = navigationHarness();
    expect(await h.navigation.navigate("p1", null, h.current)).toBe(true);
    expect(h.projectActivate).toHaveBeenCalledExactlyOnceWith("p1", "entry");
    expect(h.attentionView.cancelNavigation).not.toHaveBeenCalled(); expect(h.layout.revealTerminal).toHaveBeenCalledOnce();
  });

  it("uses context intent for an explicit Attention terminal instead of applying permission priority", async () => {
    const h = navigationHarness(); const action: WorkSummaryAction = { kind: "terminal", terminalId: "term-2", generation: 7 };
    expect(await h.navigation.navigate("p1", action, h.current)).toBe(true);
    expect(h.projectActivate).toHaveBeenCalledExactlyOnceWith("p1", "context");
    expect(h.navigateWorkAction).toHaveBeenCalledExactlyOnceWith(action, "p1");
    expect(h.attentionView.cancelNavigation).not.toHaveBeenCalled();
  });

  it("cancels pending Attention navigation and reveals the terminal for direct rail and project shortcut entry", async () => {
    const h = navigationHarness(); expect(await h.navigation.enter("p1")).toBe(true);
    expect(h.attentionView.cancelNavigation).toHaveBeenCalledExactlyOnceWith();
    expect(h.layout.revealTerminal).toHaveBeenCalledOnce();
    expect(h.projectActivate).toHaveBeenCalledExactlyOnceWith("p1", "entry");
  });
});

describe("renderer project creation actions", () => {
  it("inherits the active session for agents, never for a shell, using the captured project", async () => {
    const h = harness();
    await h.view.create("agent");
    expect(h.createTerminal).toHaveBeenCalledExactlyOnceWith({ type: "agent", projectId: "p1", fromTerminalId: "term-1" });
    h.createTerminal.mockClear();
    await h.view.create("shell", "/bin/zsh");
    expect(h.createTerminal).toHaveBeenCalledExactlyOnceWith({ type: "shell", projectId: "p1", shell: "/bin/zsh" });
  });

  it("does not inherit a terminal from another project", async () => {
    const h = harness(); h.first.projectId = "p2";
    await h.view.create("agent");
    expect(h.createTerminal).toHaveBeenCalledExactlyOnceWith({ type: "agent", projectId: "p1" });
  });

  it.each(["agent", "shell"] as const)("creates %s through the existing API for the captured project and selects only its reply", async (type) => {
    const h = harness(null);
    expect(await h.view.create(type)).toEqual({ ok: true, id: "term-3" });
    expect(h.createTerminal).toHaveBeenCalledExactlyOnceWith({ type, projectId: "p1" });
    expect(h.activatePaneWhenReady).toHaveBeenCalledExactlyOnceWith("term-3");
  });

  it.each(["another project", "new entry in same project"])("does not steal focus after %s wins the creation race", async (reason) => {
    const h = harness(null);
    let resolve!: (result: { ok: boolean; id: string }) => void;
    h.createTerminal.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const request = h.view.create("shell");
    h.view.switchProject(reason === "another project" ? "p2" : "p1", 4);
    resolve({ ok: true, id: "term-3" }); await request;
    expect(h.activatePaneWhenReady).not.toHaveBeenCalled();
  });

  it("rejects missing project and reports refused or rejected creation without activation", async () => {
    const h = harness(null); h.view.switchProject(null, 4);
    expect((await h.view.create("agent")).ok).toBe(false); expect(h.createTerminal).not.toHaveBeenCalled();
    h.view.switchProject("p1", 5); h.createTerminal.mockResolvedValueOnce({ ok: false, error: "busy" });
    expect(await h.view.create("shell")).toEqual({ ok: false, error: "busy" });
    h.createTerminal.mockRejectedValueOnce(new Error("IPC unavailable"));
    expect(await h.view.create("agent")).toEqual({ ok: false, error: "IPC unavailable" });
    expect(h.activatePaneWhenReady).not.toHaveBeenCalled();
  });
});
