import { describe, expect, it } from "vitest";
import { shellLineEdit, type LineEditKey, type LineEditMode } from "../../../src/terminal-keys.ts";

const legacy: LineEditMode = { modifierReporting: false, applicationCursor: false };
const reporting: LineEditMode = { modifierReporting: true, applicationCursor: false };
const appCursor: LineEditMode = { modifierReporting: false, applicationCursor: true };

function key(partial: Partial<LineEditKey>): LineEditKey {
  return {
    type: "keydown",
    key: "ArrowLeft",
    code: "ArrowLeft",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...partial,
  };
}

describe("shell line-edit chords", () => {
  it("keeps Command local because xterm never transmits it", () => {
    expect(shellLineEdit(key({ metaKey: true }), reporting)).toBe("\x01");
    expect(shellLineEdit(key({ metaKey: true, key: "ArrowRight", code: "ArrowRight" }), legacy)).toBe("\x05");
    expect(shellLineEdit(key({ metaKey: true, key: "ArrowUp", code: "ArrowUp" }), legacy)).toBe("\x10");
  });

  it("uses legacy encodings until the child asks for modifier reporting", () => {
    expect(shellLineEdit(key({ altKey: true }), legacy)).toBe("\x1bb");
    expect(shellLineEdit(key({ altKey: true, key: "ArrowRight", code: "ArrowRight" }), legacy)).toBe("\x1bf");
    expect(shellLineEdit(key({ altKey: true, key: "Delete", code: "Delete" }), legacy)).toBe("\x1bd");
    expect(shellLineEdit(key({ ctrlKey: true }), legacy)).toBe("\x1b[D");
    expect(shellLineEdit(key({ ctrlKey: true }), appCursor)).toBe("\x1bOD");
    expect(shellLineEdit(key({ shiftKey: true, key: "ArrowUp", code: "ArrowUp" }), legacy)).toBe("\x1b[A");
    expect(shellLineEdit(key({ ctrlKey: true, key: "Home", code: "Home" }), legacy)).toBe("\x1b[H");
    expect(shellLineEdit(key({ altKey: true, key: "PageUp", code: "PageUp" }), legacy)).toBe("\x1b[5~");
    expect(shellLineEdit(key({ ctrlKey: true, key: "F5", code: "F5" }), legacy)).toBe("\x1b[15~");
  });

  it("forwards modifier keys once the child enabled reporting", () => {
    expect(shellLineEdit(key({ ctrlKey: true }), reporting)).toBeNull();
    expect(shellLineEdit(key({ altKey: true }), reporting)).toBeNull();
    expect(shellLineEdit(key({ ctrlKey: true, key: "F5", code: "F5" }), reporting)).toBeNull();
  });

  it("leaves plain keys and Shift+Page to xterm", () => {
    expect(shellLineEdit(key({}), legacy)).toBeNull();
    expect(shellLineEdit(key({ shiftKey: true, key: "PageDown", code: "PageDown" }), legacy)).toBeNull();
    expect(shellLineEdit(key({ metaKey: true, key: "Delete", code: "Delete" }), legacy)).toBeNull();
  });
});
