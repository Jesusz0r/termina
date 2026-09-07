import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");

describe("multi-project editor event routing", () => {
  it("does not auto-open files or reveal the editor for a background project", () => {
    expect(renderer).toContain("applySharedEditorHooks(baseEditorInstance, null)");
    expect(renderer).toContain("applySharedEditorHooks(editorMgr, view.id)");
    expect(renderer).toContain("if (projectId !== null && activeProjectId !== projectId) return;");

    const handlerStart = renderer.indexOf("window.pi.onToolTarget((p) => {");
    const handlerEnd = renderer.indexOf("const lastChangePush", handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = renderer.slice(handlerStart, handlerEnd);
    expect(handler).toContain("activeProjectId !== p.projectId");
    expect(handler.indexOf("activeProjectId !== p.projectId")).toBeLessThan(handler.indexOf("ensureProjectEditor(view).openFile"));
  });

  it("queues background agent auto-opens and replays them on project activation", () => {
    const handlerStart = renderer.indexOf("window.pi.onToolTarget((p) => {");
    const handlerEnd = renderer.indexOf("const lastChangePush", handlerStart);
    const handler = renderer.slice(handlerStart, handlerEnd);
    expect(handler).toContain("pendingToolTargets");
    // Queued targets open pinned (not preview) when the project returns.
    expect(renderer).toContain("drainPendingToolTargets(activeProjectId)");
    expect(renderer).toContain("pendingToolTargets.delete(projectId)");
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
});
