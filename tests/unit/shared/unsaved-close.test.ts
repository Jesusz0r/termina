import { describe, expect, it } from "vitest";
import { decideUnsavedClose, unsavedCloseMessage } from "../../../shared/unsaved-close.ts";

describe("decideUnsavedClose", () => {
  it("proceeds when nothing is dirty, ignoring a leftover choice", () => {
    expect(decideUnsavedClose(false, null)).toBe("proceed");
    expect(decideUnsavedClose(false, "cancel")).toBe("proceed");
    expect(decideUnsavedClose(false, "save")).toBe("proceed");
  });

  it("saves, discards, or aborts when buffers are dirty", () => {
    expect(decideUnsavedClose(true, "save")).toBe("save");
    expect(decideUnsavedClose(true, "discard")).toBe("proceed");
    expect(decideUnsavedClose(true, "cancel")).toBe("abort");
    expect(decideUnsavedClose(true, null)).toBe("abort");
  });
});

describe("unsavedCloseMessage", () => {
  it("names a single file and counts many", () => {
    expect(unsavedCloseMessage(1, "app.ts")).toBe("app.ts has unsaved changes.");
    expect(unsavedCloseMessage(1)).toBe("1 file has unsaved changes.");
    expect(unsavedCloseMessage(3)).toBe("3 files have unsaved changes.");
  });
});
