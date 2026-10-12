import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { ProjectWorkspaceRef, TerminaBridge } from "../../../shared/types.ts";

const source = ts.createSourceFile("editor.ts", readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const methods: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && ["updateReadOnly", "setLocked", "saveActive", "flushKeys", "chainSave"].includes(node.name.getText(source))) {
    methods.push(node.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
const factory = ts.transpile(`class Editor { ${methods.join("\n")} } return new Editor();`, { target: ts.ScriptTarget.ES2022 });
interface Tab { key: string; media: null; readOnly: boolean; owner: ProjectWorkspaceRef; model: { getValue(): string; getAlternativeVersionId(): number }; savedVersionId: number }
interface Harness {
  activeKey: string;
  tabs: Map<string, Tab>;
  locked: boolean;
  setLocked(locked: boolean): void;
  updateReadOnly(): void;
  saveActive(): Promise<void>;
  flushKeys(keys: string[], writerId?: string): Promise<{ ok: boolean; failed: string[] }>;
}

function fixture() {
  const sourceTab: Tab = { key: "/source/file.txt", media: null, readOnly: false, owner: { projectId: "project", workspaceId: "primary" },
    model: { getValue: () => "source draft", getAlternativeVersionId: () => 2 }, savedVersionId: 1 };
  const candidate: Tab = { ...sourceTab, key: "/candidate/file.txt", readOnly: true, owner: { projectId: "project", workspaceId: "candidate" } };
  const saveFile = vi.fn<TerminaBridge["saveFile"]>().mockResolvedValue({ ok: true });
  const flushSave = vi.fn<TerminaBridge["flushSave"]>().mockResolvedValue({ ok: true });
  const updateOptions = vi.fn();
  const context = { window: { termina: { saveFile, flushSave } }, toast: vi.fn(), pathBasename: (path: string) => path, isTextTab: (tab: Tab) => tab.media === null };
  const editor = new Function(...Object.keys(context), factory)(...Object.values(context)) as Harness;
  Object.assign(editor, {
    activeKey: candidate.key, tabs: new Map([[sourceTab.key, sourceTab], [candidate.key, candidate]]), locked: false,
    editor: { updateOptions }, isTimelineActive: () => editor.activeKey.startsWith("timeline:"),
    userDirty: new Set([sourceTab.key, candidate.key]), deletedOnDisk: new Set(), saveQueue: new Map(),
    confirmRecoveredSave: async () => true, acknowledgeSave: vi.fn(),
  });
  return { editor, sourceTab, candidate, saveFile, flushSave, updateOptions };
}

describe("editor preserves each file's authoritative read-only access", () => {
  it("keeps an idle candidate read-only after the agent unlocks", () => {
    const { editor, updateOptions } = fixture();
    editor.setLocked(true);
    editor.setLocked(false);
    expect(updateOptions.mock.calls.map(([options]) => options)).toEqual([{ readOnly: true }, { readOnly: true }]);
  });

  it("recomputes access when switching between cached candidate and source tabs", () => {
    const { editor, sourceTab, candidate, updateOptions } = fixture();
    editor.updateReadOnly();
    editor.activeKey = sourceTab.key;
    editor.updateReadOnly();
    editor.activeKey = candidate.key;
    editor.updateReadOnly();
    expect(updateOptions.mock.calls.map(([options]) => options)).toEqual([{ readOnly: true }, { readOnly: false }, { readOnly: true }]);
  });

  it("retains busy-agent and snapshot locks for otherwise editable source files", () => {
    const { editor, sourceTab, updateOptions } = fixture();
    editor.activeKey = sourceTab.key;
    editor.setLocked(true);
    editor.activeKey = "timeline:term:event";
    editor.setLocked(false);
    expect(updateOptions.mock.calls.map(([options]) => options)).toEqual([{ readOnly: true }, { readOnly: true }]);
  });

  it("never submits a read-only candidate through ordinary Save", async () => {
    const { editor, sourceTab, saveFile } = fixture();
    await editor.saveActive();
    expect(saveFile).not.toHaveBeenCalled();
    editor.activeKey = sourceTab.key;
    await editor.saveActive();
    expect(saveFile).toHaveBeenCalledExactlyOnceWith(sourceTab.key, "source draft", sourceTab.owner, false);
  });

  it.each([undefined, "preflight:holder"])("reports a dirty read-only model without silently dropping it or flushing it (writer=%s)", async (writer) => {
    const { editor, candidate, sourceTab, saveFile, flushSave } = fixture();
    expect(await editor.flushKeys([candidate.key, sourceTab.key], writer)).toEqual({ ok: false, failed: [candidate.key] });
    const save = writer ? flushSave : saveFile;
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toBe(sourceTab.key);
    expect(candidate.savedVersionId).toBe(1);
    expect(editor.tabs.get(candidate.key)).toBe(candidate);
  });
});
