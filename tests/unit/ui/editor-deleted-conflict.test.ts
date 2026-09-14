import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../src/styles.css", import.meta.url), "utf8");

/** Body of a class method or member, including nested blocks. */
function memberBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `missing ${signature}`).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf("{", start + signature.length);
  expect(brace, `unopened ${signature}`).toBeGreaterThan(start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(brace, i + 1);
    }
  }
  throw new Error(`unclosed ${signature}`);
}

describe("external deletion keeps dirty buffers (refs #127)", () => {
  it("retains a dirty buffer with a deleted-on-disk conflict instead of closing it", () => {
    const closeIfOpen = memberBody(editor, "closeIfOpen(path: string): void");
    expect(closeIfOpen).toContain("if (this.userDirty.has(resolved))");
    expect(closeIfOpen).toContain("this.deletedOnDisk.add(resolved)");
    expect(closeIfOpen).toContain('tab.dom.classList.add("conflict", "deleted")');
    expect(closeIfOpen).toContain("deleted on disk; save to restore the file or close to discard");
    expect(closeIfOpen).toContain("this.onConflict(resolved)");
    // The dirty branch returns before any close; only clean tabs auto-close.
    expect(closeIfOpen.indexOf("return;")).toBeLessThan(closeIfOpen.indexOf("this.closeTab(resolved)"));
  });

  it("still auto-closes clean tabs on deletion", () => {
    const closeIfOpen = memberBody(editor, "closeIfOpen(path: string): void");
    expect(closeIfOpen).toContain("this.closeTab(resolved)");
  });

  it("routes the deletion to the owning project editor, including background projects", () => {
    const start = renderer.indexOf("window.termina.onFileDeleted((p) => {");
    expect(start).toBeGreaterThanOrEqual(0);
    const handler = renderer.slice(start, renderer.indexOf("function syncExplorerChanged", start));
    expect(handler).toContain("projectViews.get(p.projectId)");
    expect(handler).toContain("view.workspaceId !== p.workspaceId");
    expect(handler).toContain("view.editorMgr?.closeIfOpen(p.path)");
  });

  it("restores the file through the existing create + save IPC when a deleted buffer saves", () => {
    const restore = memberBody(editor, "private async restoreDeletedBeforeSave(");
    expect(restore).toContain("this.deletedOnDisk.has(tab.key)");
    expect(restore).toContain("this.relativePath(tab.key)");
    expect(restore).toContain('window.termina.createEntry(tab.owner.projectId, rel, "file")');
    expect(memberBody(editor, "private async saveActive()")).toContain("await this.restoreDeletedBeforeSave(live)");
    expect(memberBody(editor, "async flushKeys(keys: string[], writerId?: string): Promise<{ ok: boolean; failed: string[] }>")).toContain(
      "await this.restoreDeletedBeforeSave(live)",
    );
  });

  it("clears the deletion marking when the file exists again", () => {
    // Successful save recreates the file (both ordinary save and flush share acknowledgeSave).
    const ack = memberBody(editor, "private acknowledgeSave(");
    expect(ack).toContain("if (this.deletedOnDisk.delete(key))");
    expect(ack).toContain('tab.dom.classList.remove("deleted", "conflict")');
    // A content push proves external recreation.
    const update = memberBody(editor, "updateContent(path: string, content: string, changedLines?: number[]): void");
    expect(update).toContain("if (this.deletedOnDisk.delete(resolved))");
    expect(update).toContain('tab.dom.classList.remove("deleted")');
    // Closing forgets the marking with the tab.
    expect(memberBody(editor, "closeTab(key: string): void")).toContain("this.deletedOnDisk.delete(key)");
  });

  it("names the deletion in the failed-restore toast", () => {
    expect(memberBody(editor, "private async saveActive()")).toContain("could not restore");
    expect(memberBody(editor, "private async saveActive()")).toContain("(deleted on disk)");
  });

  it("discards only through the existing unsaved close decision", () => {
    // Dirty deleted buffers close via requestCloseTab → prompt → flushKeys/closeKeys.
    const once = memberBody(editor, "private async requestCloseKeysOnce(");
    expect(once).toContain("decideUnsavedClose");
    expect(once).toContain("this.flushKeys(unique)");
    expect(once).toContain("this.closeKeys(unique)");
  });

  it("styles the deleted tab distinctly from a plain conflict", () => {
    expect(css).toContain(".editor-tab.deleted .tab-name");
    expect(css).toMatch(/\.editor-tab\.deleted \.tab-name\s*\{[^}]*text-decoration:\s*line-through/);
  });
});
