import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { TerminalCloseResult } from "../../../shared/types.ts";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functions = ["disposePane", "closePane"].map((name) => source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source));
const code = ts.transpileModule(`${functions.join("\n")}\nreturn closePane;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function pane(id: string, projectId = "p1") {
  return { instanceId: id, generation: 1, projectId, view: { dispose: vi.fn() }, container: { remove: vi.fn() }, tabEl: { remove: vi.fn() } };
}

function harness() {
  const first = pane("term-1");
  const second = pane("term-2");
  const background = pane("term-3", "p2");
  const panes = new Map([[first.instanceId, first], [second.instanceId, second], [background.instanceId, background]]);
  const closeTerminal = vi.fn(async (): Promise<TerminalCloseResult | undefined> => ({ ok: true }));
  const bindings = {
    panes,
    pendingTerminalCloses: new Set(),
    closingPanes: new Map(),
    lastActivePane: new Map([["p1", "term-1"]]),
    activeId: "term-1",
    window: { termina: { closeTerminal } },
    forgetPaneActivityCue: vi.fn(),
    syncExplorerChanged: vi.fn(),
    updateProjectAttention: vi.fn(),
    activatePane: vi.fn(),
    renderChrome: vi.fn(),
    toast: vi.fn(),
  };
  const close = new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as (id: string) => Promise<void>;
  return { first, second, background, closeTerminal, close, ...bindings };
}

describe("renderer acknowledged terminal close", () => {
  it("keeps the pane and roster eligibility while main confirmation is pending", async () => {
    const h = harness();
    let resolve!: (result: TerminalCloseResult) => void;
    h.closeTerminal.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const request = h.close("term-1");
    await h.close("term-1");
    expect(h.closeTerminal).toHaveBeenCalledTimes(1);
    expect(h.panes.get("term-1")).toBe(h.first);
    expect(h.first.view.dispose).not.toHaveBeenCalled();
    expect(h.closingPanes.size).toBe(0);
    resolve({ ok: true });
    await request;
    expect(h.first.view.dispose).toHaveBeenCalledTimes(1);
    expect(h.panes.has("term-1")).toBe(false);
    expect(h.activatePane).toHaveBeenCalledExactlyOnceWith("term-2");
  });

  it.each(["cancel", "rejected", "unavailable document", "exception"])("preserves the view after %s", async (failure) => {
    const h = harness();
    if (failure === "cancel") h.closeTerminal.mockResolvedValueOnce({ ok: false, cancelled: true });
    if (failure === "rejected") h.closeTerminal.mockResolvedValueOnce({ ok: false, error: "stale target" });
    if (failure === "unavailable document") h.closeTerminal.mockResolvedValueOnce(undefined);
    if (failure === "exception") h.closeTerminal.mockRejectedValueOnce(new Error("IPC failed"));
    await h.close("term-1");
    expect(h.panes.get("term-1")).toBe(h.first);
    expect(h.first.view.dispose).not.toHaveBeenCalled();
    expect(h.closingPanes.size).toBe(0);
    expect(h.pendingTerminalCloses.size).toBe(0);
    expect(h.activatePane).not.toHaveBeenCalled();
    if (failure === "cancel" || failure === "unavailable document") expect(h.toast).not.toHaveBeenCalled();
    else expect(h.toast).toHaveBeenCalledOnce();
  });

  it("does not dispose a newer generation or replacement pane after the reply", async () => {
    for (const replace of [false, true]) {
      const h = harness();
      h.closeTerminal.mockImplementationOnce(async () => {
        if (replace) h.panes.set("term-1", { ...h.first, generation: 2 });
        else h.first.generation = 2;
        return { ok: true };
      });
      await h.close("term-1");
      expect(h.panes.has("term-1")).toBe(true);
      expect(h.first.view.dispose).not.toHaveBeenCalled();
      expect(h.closingPanes.size).toBe(0);
    }
  });

  it("does not dispose twice when the authoritative roster already removed the pane", async () => {
    const h = harness();
    h.closeTerminal.mockImplementationOnce(async () => {
      h.panes.delete("term-1");
      h.first.view.dispose();
      return { ok: true };
    });
    await h.close("term-1");
    expect(h.first.view.dispose).toHaveBeenCalledOnce();
    expect(h.closingPanes.get("term-1")).toEqual({ generation: 1 });
  });
});
