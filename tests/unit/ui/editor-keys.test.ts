import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COMMAND_DEFINITIONS } from "../../../shared/commands.ts";

const editor = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");

describe("editor save and clipboard routing", () => {
  it("registers Save as CmdOrCtrl+S through the command/menu path", () => {
    const save = COMMAND_DEFINITIONS.find((d) => d.command === "save");
    expect(save?.defaultShortcut).toBe("CmdOrCtrl+S");
    expect(save?.scope).toBe("renderer");
    expect(renderer).toContain('commands.register("save", () => {');
    expect(renderer).toContain("activeEditor().saveActive()");
    expect(main).toContain('{ label: "Save", accelerator: shortcut("save"), click: send("save") }');
    expect(editor).not.toContain("KeyMod.CtrlCmd | monaco.KeyCode.KeyS");
  });

  it("copies through the host clipboard instead of Monaco execCommand actions", () => {
    expect(editor).toContain("private async runEditorClipboard(");
    expect(editor).toContain("window.termina.writeClipboard(text)");
    expect(editor).toContain("window.termina.readClipboard()");
    expect(editor).toContain('this.editor.trigger("keyboard", "paste", { text })');
    expect(editor).toContain('this.editor.trigger("keyboard", "cut", null)');
    expect(editor).not.toContain("editor.action.clipboardCopyAction");
    expect(editor).not.toContain("editor.action.clipboardCutAction");
    expect(editor).not.toContain("editor.action.clipboardPasteAction");
    expect(editor).toContain("private editorOwnsClipboard()");
    expect(editor).toContain("this.editor.hasTextFocus()");
    expect(editor).toContain("this.editor.getContainerDomNode()");
  });
});
