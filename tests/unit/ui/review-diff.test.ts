import { beforeEach, describe, expect, it, vi } from "vitest";
import { cssFontFamily } from "../../../shared/types";

const stub = vi.hoisted(() => {
  const events: string[] = [];
  const focus = vi.fn();
  const editor = {
    setModel: vi.fn((model: unknown) => events.push(model === null ? "detach" : "attach")),
    updateOptions: vi.fn(),
    getModifiedEditor: vi.fn(() => ({ focus })),
    dispose: vi.fn(() => events.push("editor dispose")),
  };
  const createModel = vi.fn((value: string, language: string, uri: string) => ({
    value, language, uri,
    setValue: vi.fn(),
    dispose: vi.fn(() => events.push(`dispose ${uri}`)),
  }));
  return { events, focus, editor, createModel, createDiffEditor: vi.fn((_element: HTMLElement, _options: unknown) => editor) };
});
vi.mock("monaco-editor", () => ({
  editor: { createDiffEditor: stub.createDiffEditor, createModel: stub.createModel },
  Uri: { parse: (value: string) => value },
}));
import { ReadOnlyReviewDiff } from "../../../src/review-diff";

beforeEach(() => {
  vi.clearAllMocks();
  stub.events.length = 0;
});
const element = {} as HTMLElement;

describe("ReadOnlyReviewDiff", () => {
  it("preserves defaults and makes both sides read-only with bounded computation", () => {
    new ReadOnlyReviewDiff(element, "review");
    expect(stub.createDiffEditor).toHaveBeenCalledWith(element, {
      fontSize: 13, fontFamily: cssFontFamily(""),
      automaticLayout: true, readOnly: true, originalEditable: false,
      renderSideBySide: true, maxComputationTime: 5000,
      minimap: { enabled: false }, scrollBeyondLastLine: false,
    });
    new ReadOnlyReviewDiff(element, "inspector", false);
    expect(stub.createDiffEditor.mock.calls.at(-1)?.[1]).toMatchObject({ renderSideBySide: false });
    // A new inspector must inherit the user's active theme, not switch all editors to stock dark.
    expect(stub.createDiffEditor.mock.calls.at(-1)?.[1]).not.toHaveProperty("theme");
  });

  it("namespaces simultaneous models and infers their language", () => {
    const review = new ReadOnlyReviewDiff(element, "review");
    const inspector = new ReadOnlyReviewDiff(element, "selected work");
    review.setDiff("/project/a.ts", "base", "current");
    inspector.setDiff("/project/a.ts", "base", "current");
    const models = stub.createModel.mock.results.map((result) => result.value);
    expect(new Set(models.map((model) => model.uri)).size).toBe(4);
    expect(models[0]).toMatchObject({ value: "base", language: "typescript" });
    expect(models[2].uri).toContain("selected%20work");
  });

  it("reuses same-path models and detaches before replacing or clearing", () => {
    const diff = new ReadOnlyReviewDiff(element, "review");
    diff.setDiff("a.ts", "old", "new");
    const [original, modified] = stub.createModel.mock.results.map((result) => result.value);
    diff.setDiff("a.ts", "base refreshed", "current refreshed");
    expect(stub.createModel).toHaveBeenCalledTimes(2);
    expect(original.setValue).toHaveBeenCalledWith("base refreshed");
    expect(modified.setValue).toHaveBeenCalledWith("current refreshed");
    stub.events.length = 0;
    diff.setDiff("b.ts", "b", "c");
    expect(stub.events).toEqual(["detach", `dispose ${original.uri}`, `dispose ${modified.uri}`, "attach"]);
    stub.events.length = 0;
    diff.clear();
    expect(stub.events[0]).toBe("detach");
    expect(stub.events).toHaveLength(3);
    diff.setDiff("b.ts", "b", "c");
    expect(stub.createModel).toHaveBeenCalledTimes(6);
  });

  it("delegates font options and focus, and disposes only once", () => {
    const diff = new ReadOnlyReviewDiff(element, "review");
    diff.setFontSize(16);
    diff.setFontFamily("Menlo");
    diff.setWordWrap(true);
    diff.setWordWrap(false);
    expect(stub.editor.updateOptions.mock.calls).toEqual([
      [{ fontSize: 16 }], [{ fontFamily: cssFontFamily("Menlo") }],
      [{ wordWrap: "on" }], [{ wordWrap: "off" }],
    ]);
    diff.focus();
    expect(stub.focus).toHaveBeenCalledOnce();
    diff.setDiff("a.ts", "a", "b");
    stub.events.length = 0;
    diff.dispose();
    diff.dispose();
    diff.clear();
    diff.setDiff("b.ts", "a", "b");
    expect(stub.events[0]).toBe("detach");
    expect(stub.events.at(-1)).toBe("editor dispose");
    expect(stub.editor.dispose).toHaveBeenCalledOnce();
    expect(stub.createModel).toHaveBeenCalledTimes(2);
  });
});
