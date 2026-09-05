import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");

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
});
