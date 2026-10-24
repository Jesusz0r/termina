import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Run the production notice and close methods with only their I/O replaced.
const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
function method(name: string): string {
  const found = main.match(new RegExp(`  private (?:async )?${name}\\([\\s\\S]*?\\n  \\}`))?.[0];
  if (!found) throw new Error(`missing ${name}`);
  return ts.transpileModule(`return ({ ${found.replace(/^  private /, "")} }).${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function fixture(response: number) {
  const dialog = { showMessageBox: vi.fn(async () => ({ response })) };
  const notice = new Function("dialog", method("noteRosterRestoreProblem"))(dialog);
  const close = new Function(method("closeUserTerminal"))();
  const failed = [{ id: "term-3", type: "agent" }, { id: "term-4", type: "shell" }];
  const project = { id: "p1", cwd: "/project", unrestoredTerminals: [...failed] };
  const live = { persist: true, closed: false };
  const app = {
    disposed: false, win: null, projects: new Map([["p1", project]]), revealWindowForSheet: vi.fn(),
    projectIsSwitching: () => false, saveTerminalRoster: vi.fn(),
    runtime: { get: (id: string) => id === "term-1" ? live : undefined },
    projectOfTerminal: () => project, closeTerminal: vi.fn(), sendInstances: vi.fn(),
  };
  return { dialog, project, failed, app,
    notice: (reasons: string[], setAside?: string) => notice.call(app, project, failed, reasons, setAside) as Promise<void>,
    close: (id: string) => close.call(app, id) };
}

describe("restore notice", () => {
  it("keeps failed tabs for the next launch by default", async () => {
    const f = fixture(0);
    await f.notice(["node was not found beside codex"]);
    expect(f.dialog.showMessageBox.mock.calls[0]![0]).toMatchObject({ buttons: ["Keep for Next Launch", "Discard"], cancelId: 0 });
    expect(f.project.unrestoredTerminals).toEqual(f.failed);
    expect(f.app.saveTerminalRoster).not.toHaveBeenCalled();
  });

  it("discards failed tabs only when the user asks", async () => {
    const f = fixture(1);
    await f.notice(["saved area unavailable"]);
    expect(f.project.unrestoredTerminals).toEqual([]);
    expect(f.app.saveTerminalRoster).toHaveBeenCalledWith(f.project);
  });

  it("names the kept copy of a damaged roster and discards nothing", async () => {
    const f = fixture(1);
    await f.notice([], "/data/terminal-rosters/key.json.corrupt-1");
    expect(f.dialog.showMessageBox.mock.calls[0]![0]).toMatchObject({ detail: expect.stringContaining("key.json.corrupt-1") });
    expect(f.project.unrestoredTerminals).toEqual(f.failed);
  });

  it("closing the last live tab keeps tabs that failed to restore", () => {
    const f = fixture(0);
    f.close("term-1");
    expect(f.project.unrestoredTerminals).toEqual(f.failed);
    expect(f.app.saveTerminalRoster).toHaveBeenCalledWith(f.project);
  });
});
