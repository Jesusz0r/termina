import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");

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

describe("editor save acknowledgment (refs #126)", () => {
  it("captures the submitted text and version before awaiting IPC", () => {
    const saveActive = memberBody(editor, "private async saveActive()");
    expect(saveActive).toContain("const submittedText = live.model.getValue()");
    expect(saveActive).toContain("const submittedVersion = live.model.getAlternativeVersionId()");
    expect(saveActive).toContain("const savedAtSubmit = live.savedVersionId");
    // The capture must precede the IPC round trip; typing during the await
    // must not move into the persisted baseline.
    expect(saveActive.indexOf("const submittedVersion")).toBeLessThan(saveActive.indexOf("await window.termina.saveFile"));
    const flushKeys = memberBody(editor, "async flushKeys(keys: string[], writerId?: string): Promise<{ ok: boolean; failed: string[] }>");
    expect(flushKeys).toContain("const submittedVersion = live.model.getAlternativeVersionId()");
    expect(flushKeys).toContain("const savedAtSubmit = live.savedVersionId");
    expect(flushKeys.indexOf("const submittedVersion")).toBeLessThan(flushKeys.indexOf("await window.termina.flushSave"));
  });

  it("never records the model's current version as saved after the await", () => {
    // The original race: `savedVersionId = model.getAlternativeVersionId()`
    // after the response marked newer unpersisted edits clean.
    expect(editor).not.toContain("savedVersionId = tab.model.getAlternativeVersionId()");
    expect(editor).not.toContain("savedVersionId = live.model.getAlternativeVersionId()");
    expect(editor).not.toContain("savedVersionId = current.model.getAlternativeVersionId()");
  });

  it("shares one acknowledgment between ordinary save and flush-save", () => {
    const ack = memberBody(editor, "private acknowledgeSave(");
    expect(ack).toContain("submittedVersion");
    expect(ack).toContain("savedAtSubmit");
    expect(memberBody(editor, "private async saveActive()")).toContain("this.acknowledgeSave(");
    expect(memberBody(editor, "async flushKeys(keys: string[], writerId?: string): Promise<{ ok: boolean; failed: string[] }>")).toContain("this.acknowledgeSave(");
  });

  it("advances the baseline only to the submitted version, and only when unclaimed", () => {
    const ack = memberBody(editor, "private acknowledgeSave(");
    // A watcher push under a clean buffer (or an applied newer ack) moves the
    // baseline first; the late ack must not drag it back to the submitted text.
    expect(ack).toContain("if (tab.savedVersionId === savedAtSubmit) tab.savedVersionId = submittedVersion");
    // Dirty state always recomputes from the current model.
    expect(ack).toContain("this.syncDirty(tab)");
    expect(ack.indexOf("tab.savedVersionId = submittedVersion")).toBeLessThan(ack.indexOf("this.syncDirty(tab)"));
  });

  it("keeps the conflict marker while post-submit edits remain dirty", () => {
    const ack = memberBody(editor, "private acknowledgeSave(");
    expect(ack).toContain("} else if (!this.userDirty.has(key)) {");
    expect(ack).toContain('tab.dom.classList.remove("conflict")');
  });

  it("ignores late acknowledgments for closed or replaced tabs", () => {
    const ack = memberBody(editor, "private acknowledgeSave(");
    expect(ack).toContain("const tab = this.tabs.get(key)");
    expect(ack).toContain("if (!tab || tab.model !== model) return;");
    const saveActive = memberBody(editor, "private async saveActive()");
    expect(saveActive).toContain("if (!live || live !== tab || !live.owner) return;");
    const flushKeys = memberBody(editor, "async flushKeys(keys: string[], writerId?: string): Promise<{ ok: boolean; failed: string[] }>");
    expect(flushKeys).toContain("if (!live || live !== tab || !live.owner) return false;");
  });

  it("serializes overlapping saves per tab so the last writer wins in order", () => {
    expect(editor).toContain("private saveQueue = new Map<string, Promise<unknown>>()");
    const chain = memberBody(editor, "private chainSave<T>(");
    expect(chain).toContain("prev.then(op, op)");
    expect(memberBody(editor, "private async saveActive()")).toContain("this.chainSave(tab.key");
    expect(memberBody(editor, "async flushKeys(keys: string[], writerId?: string): Promise<{ ok: boolean; failed: string[] }>")).toContain("this.chainSave(key");
  });

  it("treats a rejected save IPC as a failure, not an unhandled rejection", () => {
    const saveActive = memberBody(editor, "private async saveActive()");
    expect(saveActive).toContain("} catch (err) {");
    expect(saveActive).toContain("could not save");
    const flushKeys = memberBody(editor, "async flushKeys(keys: string[], writerId?: string): Promise<{ ok: boolean; failed: string[] }>");
    expect(flushKeys).toContain("} catch {");
    expect(flushKeys).toContain("return false;");
  });
});
