import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");

describe("multi-project editor event routing", () => {
  it("does not auto-open files or reveal the editor for a background project", () => {
    expect(renderer).toContain("applySharedEditorHooks(baseEditorInstance, null)");
    expect(renderer).toContain("applySharedEditorHooks(editorMgr, view.id)");
    expect(renderer).toContain("if (projectId !== null && activeProjectId !== projectId) return;");

    const handlerStart = renderer.indexOf("window.termina.onToolTarget((p) => {");
    const handlerEnd = renderer.indexOf("const lastChangePush", handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = renderer.slice(handlerStart, handlerEnd);
    expect(handler).toContain("activeProjectId !== p.projectId");
    expect(handler.indexOf("activeProjectId !== p.projectId")).toBeLessThan(handler.indexOf("ensureProjectEditor(view).openFile"));
  });

  it("queues background agent auto-opens and replays them on project activation", () => {
    const handlerStart = renderer.indexOf("window.termina.onToolTarget((p) => {");
    const handlerEnd = renderer.indexOf("const lastChangePush", handlerStart);
    const handler = renderer.slice(handlerStart, handlerEnd);
    expect(handler).toContain("pendingToolTargets");
    // Queued targets open as replaceable preview tabs when the project
    // returns: a long run must not pin a permanent tab per file it touched.
    expect(renderer).toContain("drainPendingToolTargets(activeProjectId)");
    expect(renderer).toContain("pendingToolTargets.delete(projectId)");
    const drainStart = renderer.indexOf("function drainPendingToolTargets(");
    expect(drainStart).toBeGreaterThanOrEqual(0);
    const drain = renderer.slice(drainStart, renderer.indexOf("/** Show only the active project's terminals.", drainStart));
    expect(drain).toContain("preview: true");
    expect(drain).not.toContain("preview: false");
    expect(handler).toContain("preview: true");
    expect(handler).not.toContain("preview: false");
  });

  it("reveals the editor only after the open is routed to its project", () => {
    const smartStart = renderer.indexOf("async function openFileSmart(");
    expect(smartStart).toBeGreaterThanOrEqual(0);
    const smart = renderer.slice(smartStart, renderer.indexOf("// ---------------------------------------------------------------- panels", smartStart));
    expect(smart.indexOf("setActiveProject(projId)")).toBeLessThan(smart.indexOf("revealEditor()"));
    expect(smart.indexOf("revealEditor()")).toBeLessThan(smart.indexOf("ensureProjectEditor(view).openFile"));
  });

  it("scopes shared Monaco models by project", () => {
    expect(editor).toContain("acquireSharedFileModel(path, owner)");
    expect(editor).toContain("project=");
  });

  it("prompts on user tab close and reuses the existing save flush", () => {
    expect(editor).toContain("hasDirtyModels()");
    expect(editor).toContain("requestCloseTab(key)");
    expect(editor).toContain("void this.requestCloseTab(key)");
    expect(editor).toContain("decideUnsavedClose");
    expect(editor).toContain("flushKeys(unique)");
    expect(editor).toContain("window.termina.saveFile");
    const closeClick = editor.indexOf('close.addEventListener("click"');
    const middleClick = editor.indexOf("e.button === 1");
    expect(closeClick).toBeGreaterThanOrEqual(0);
    expect(middleClick).toBeGreaterThan(closeClick);
    expect(editor.indexOf("void this.requestCloseTab(key)", closeClick)).toBeGreaterThan(closeClick);
    expect(editor.indexOf("void this.requestCloseTab(key)", middleClick)).toBeGreaterThan(middleClick);
    expect(editor).toContain('{ label: "Close", action: () => void this.requestCloseTab(key) }');
    expect(renderer).toContain("confirmUnsavedEditors(projectId)");
    expect(renderer).toContain("editor.hasDirtyModels()");
    expect(renderer).toContain("editor.flushAll()");
    expect(renderer).toContain("onUnsavedConfirm");
  });
});
