import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkChanges } from "../../../src/main/work-changes.ts";
import type { ModifiedFile, ReviewDiffResult, ReviewFilesResult, ReviewTarget, TerminaBridge } from "../../../shared/types.ts";
import { installFakeDom, type FakeEl } from "./fake-dom.ts";

const renderer = vi.hoisted(() => ({ setDiff: vi.fn(), clear: vi.fn(), dispose: vi.fn(), focus: vi.fn(), create: vi.fn() }));
vi.mock("../../../src/review-diff.ts", () => ({
  ReadOnlyReviewDiff: class {
    constructor(...args: unknown[]) { renderer.create(...args); }
    setDiff(...args: unknown[]) { renderer.setDiff(...args); }
    clear() { renderer.clear(); }
    dispose() { renderer.dispose(); }
    focus() { renderer.focus(); }
  },
}));
let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createWorkChanges>;
beforeEach(() => { dom = installFakeDom(); vi.clearAllMocks(); });
afterEach(() => { view?.dispose(); dom.cleanup(); });
const flush = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 8; i++) await Promise.resolve(); };
const target: ReviewTarget = { projectId: "project-1", workspaceId: "candidate-1", root: "/worlds/candidate", terminalId: "worker", generation: 12 };
const file = (index = 0): ModifiedFile => ({ path: `${target.root}/file-${index}.ts`, relPath: `file-${index}.ts`, status: "modified" });
const diff = (overrides: Partial<Extract<ReviewDiffResult, { ok: true }>> = {}): ReviewDiffResult => ({
  ok: true, ...file(), baseline: "before\n", current: "after\n", deleted: false, ...overrides,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const element = dom.document.createElement("section");
  dom.document.body.append(element);
  const getReviewFiles = vi.fn<TerminaBridge["getReviewFiles"]>().mockResolvedValue({ ok: true, files: [file()], total: 1 });
  const getReviewDiff = vi.fn<TerminaBridge["getReviewDiff"]>().mockResolvedValue(diff());
  view = createWorkChanges({ element: element as unknown as HTMLElement, getReviewFiles, getReviewDiff });
  view.render(target, "task-1");
  const node = (name: string): FakeEl => element.querySelector(`.overview-changes-${name}`)!;
  return { element, getReviewFiles, getReviewDiff, node, rows: () => node("list").querySelectorAll("button") };
}

describe("read-only terminal changes in the selected-work inspector", () => {
  it("does not fetch or instantiate Monaco on selection; explains terminal scope, not task attribution", async () => {
    const h = harness();
    expect(h.element.hidden).toBe(true);
    expect(h.getReviewFiles).not.toHaveBeenCalled();
    expect(h.getReviewDiff).not.toHaveBeenCalled();
    expect(renderer.create).not.toHaveBeenCalled();
    view.open(); await flush();
    expect(h.getReviewFiles).toHaveBeenCalledExactlyOnceWith(target, 0);
    expect(h.node("scope").textContent).toContain(target.terminalId);
    expect(h.node("scope").textContent).toContain(target.root);
    expect(h.node("description").textContent).toMatch(/cumulative.*not.*task/i);
    expect(h.node("description").textContent).toMatch(/unsaved.*not included/i);
    expect(renderer.create).not.toHaveBeenCalled();
  });

  it.each(["modified", "created", "deleted"] as const)("loads a %s diff only on file click, without mutating the input", async (status) => {
    const h = harness();
    const recorded = { ...file(), status };
    const result = diff({ status, baseline: status === "created" ? null : "before\n", current: status === "deleted" ? "" : "after\n", deleted: status === "deleted" });
    const before = JSON.stringify(result);
    h.getReviewFiles.mockResolvedValue({ ok: true, files: [recorded], total: 1 });
    h.getReviewDiff.mockResolvedValue(result);
    view.open(); await flush();
    expect(h.getReviewDiff).not.toHaveBeenCalled();
    h.rows()[0]!.focus(); h.rows()[0]!.click(); await flush();
    expect(h.getReviewDiff).toHaveBeenCalledExactlyOnceWith(target, recorded.path);
    expect(renderer.create).toHaveBeenCalledExactlyOnceWith(h.node("diff"), "work-inspector", false);
    expect(renderer.setDiff).toHaveBeenCalledExactlyOnceWith(recorded.path, status === "created" ? "" : "before\n", status === "deleted" ? "" : "after\n");
    expect(h.node("filename").textContent).toBe(recorded.relPath);
    expect(h.node("diff-section").hidden).toBe(false);
    expect(h.rows()[0]!.getAttribute("aria-current")).toBe("true");
    expect(dom.document.activeElement).toBe(h.rows()[0]);
    expect(JSON.stringify(result)).toBe(before);
    h.node("focus").click(); expect(renderer.focus).toHaveBeenCalledOnce();
  });

  it("renders filenames literally and never provides mutation controls", async () => {
    const h = harness();
    const name = '<img src=x onerror="alert(1)">.ts';
    h.getReviewFiles.mockResolvedValue({ ok: true, files: [{ ...file(), relPath: name }], total: 1 });
    view.open(); await flush();
    expect(h.rows()[0]!.querySelector(".overview-changes-path")!.textContent).toBe(name);
    expect(h.element.querySelector("img")).toBeNull();
    expect(h.element.querySelectorAll("button").map((button) => button.textContent).join(" ")).not.toMatch(/accept|revert|save|apply|clear/i);
  });

  it("explains an identical baseline and current file rather than implying new changes", async () => {
    const h = harness(); h.getReviewDiff.mockResolvedValue(diff({ current: "before\n" }));
    view.open(); await flush(); h.rows()[0]!.click(); await flush();
    expect(h.node("diff-status").textContent).toMatch(/no.*difference/i);
    expect(renderer.setDiff).toHaveBeenCalledWith(file().path, "before\n", "before\n");
  });

  it("distinguishes deleting an empty file from an unchanged empty text file", async () => {
    const h = harness(); h.getReviewDiff.mockResolvedValue(diff({ baseline: "", current: "", deleted: true, status: "deleted" }));
    view.open(); await flush(); h.rows()[0]!.click(); await flush();
    expect(h.node("diff-status").textContent).toContain("Deleted on disk");
    expect(h.node("diff-status").textContent).not.toContain("No current text difference");
  });

  it("shows a truthful empty recorded list without inventing declared task files", async () => {
    const h = harness(); h.getReviewFiles.mockResolvedValue({ ok: true, files: [], total: 0 });
    view.open(); await flush();
    expect(h.node("status").textContent).toMatch(/no recorded.*not.*unchanged/i);
    expect(h.rows()).toHaveLength(0);
    expect(h.node("more").hidden).toBe(true);
    expect(h.getReviewDiff).not.toHaveBeenCalled();
  });

  it("pages explicitly in batches, retains existing file controls and focuses the first new row", async () => {
    const h = harness();
    const first = Array.from({ length: 50 }, (_, index) => file(index));
    const last = Array.from({ length: 7 }, (_, index) => file(index + 50));
    h.getReviewFiles.mockResolvedValueOnce({ ok: true, files: first, total: 57 }).mockResolvedValueOnce({ ok: true, files: last, total: 57 });
    view.open(); await flush();
    const control = h.rows()[0]!;
    expect(h.rows()).toHaveLength(50);
    expect(h.node("more").textContent).toContain("7 remaining");
    h.node("more").click(); await flush();
    expect(h.getReviewFiles).toHaveBeenLastCalledWith(target, 50);
    expect(h.rows()).toHaveLength(57);
    expect(h.rows()[0]).toBe(control);
    expect(dom.document.activeElement).toBe(h.rows()[50]);
    expect(h.node("more").hidden).toBe(true);
  });

  it.each(["files", "diff"] as const)("displays a %s failure explicitly and permits a manual retry", async (operation) => {
    const h = harness();
    if (operation === "files") h.getReviewFiles.mockRejectedValueOnce(new Error("read failed"));
    else h.getReviewDiff.mockResolvedValueOnce({ ok: false, error: "Baseline unavailable" });
    view.open(); await flush();
    if (operation === "files") {
      expect(h.node("status").textContent).toMatch(/could not.*load/i);
      h.node("reload").click(); await flush();
      expect(h.rows()).toHaveLength(1);
    } else {
      h.rows()[0]!.click(); await flush();
      expect(h.node("diff-status").textContent).toBe("Baseline unavailable");
      expect(h.node("diff").hidden).toBe(true);
      expect(renderer.setDiff).not.toHaveBeenCalled();
      h.rows()[0]!.click(); await flush();
      expect(renderer.setDiff).toHaveBeenCalledOnce();
    }
  });

  it("a failed next page preserves its existing rows and allows retry at the same offset", async () => {
    const h = harness();
    h.getReviewFiles.mockResolvedValueOnce({ ok: true, files: [file()], total: 2 })
      .mockResolvedValueOnce({ ok: false, error: "page unavailable" }).mockResolvedValueOnce({ ok: true, files: [file(1)], total: 2 });
    view.open(); await flush(); const control = h.rows()[0]!;
    h.node("more").click(); await flush();
    expect(h.rows()).toEqual([control]);
    expect(h.node("status").textContent).toContain("page unavailable");
    expect(h.node("more").hidden).toBe(false);
    h.node("more").click(); await flush();
    expect(h.getReviewFiles).toHaveBeenLastCalledWith(target, 1);
    expect(h.rows()).toHaveLength(2);
  });

  it("keeps loaded controls, diff and focus on an unchanged selection refresh", async () => {
    const h = harness(); view.open(); await flush(); h.rows()[0]!.click(); await flush();
    const control = h.rows()[0]!; control.focus();
    view.render(structuredClone(target), "task-1");
    expect(h.rows()[0]).toBe(control);
    expect(dom.document.activeElement).toBe(control);
    expect(h.getReviewFiles).toHaveBeenCalledOnce();
    expect(renderer.setDiff).toHaveBeenCalledOnce();
    expect(h.node("diff-section").hidden).toBe(false);
  });

  it.each(["projectId", "workspaceId", "root", "terminalId", "generation", "selection"] as const)("fences pending files and diff on a changed %s", async (change) => {
    const h = harness(); view.open(); await flush();
    const pendingDiff = deferred<ReviewDiffResult>(); const pendingFiles = deferred<ReviewFilesResult>();
    h.getReviewDiff.mockReturnValueOnce(pendingDiff.promise);
    h.rows()[0]!.click();
    h.getReviewFiles.mockReturnValueOnce(pendingFiles.promise);
    h.node("more").hidden = false; h.node("more").click();
    const next = { ...target };
    if (change === "generation") next.generation++;
    else if (change !== "selection") next[change] = "different";
    view.render(next, change === "selection" ? "task-2" : "task-1");
    pendingDiff.resolve(diff({ current: "obsolete" })); pendingFiles.resolve({ ok: true, files: [file(1)], total: 2 }); await flush();
    expect(h.element.hidden).toBe(true);
    expect(h.rows()).toHaveLength(0);
    expect(renderer.setDiff).not.toHaveBeenCalled();
  });

  it.each(["invalidate", "clear", "unavailable", "dispose"] as const)("discards a late diff after %s and clears previously loaded models", async (operation) => {
    const h = harness(); view.open(); await flush(); h.rows()[0]!.click(); await flush();
    const pending = deferred<ReviewDiffResult>(); h.getReviewDiff.mockReturnValueOnce(pending.promise);
    h.rows()[0]!.click();
    view[operation](); pending.resolve(diff({ current: "obsolete" })); await flush();
    expect(renderer.setDiff).toHaveBeenCalledOnce();
    expect(renderer.clear).toHaveBeenCalled();
    expect(h.node("diff-section").hidden).toBe(true);
    if (operation === "invalidate") {
      expect(h.element.hidden).toBe(false);
      expect(h.node("status").textContent).toMatch(/changed.*reload/i);
      h.node("reload").click(); await flush(); expect(h.rows()).toHaveLength(1);
    }
  });

  it("keeps only the latest requested file when replies resolve out of order", async () => {
    const h = harness(); h.getReviewFiles.mockResolvedValue({ ok: true, files: [file(), file(1)], total: 2 });
    const first = deferred<ReviewDiffResult>(); const last = deferred<ReviewDiffResult>();
    h.getReviewDiff.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    view.open(); await flush(); h.rows()[0]!.click(); h.rows()[1]!.click();
    last.resolve(diff({ ...file(1), current: "latest" })); await flush();
    first.resolve(diff({ current: "old" })); await flush();
    expect(renderer.setDiff).toHaveBeenCalledExactlyOnceWith(file(1).path, "before\n", "latest");
  });

  it("rejects mismatched diff paths instead of showing a different file's content", async () => {
    const h = harness(); h.getReviewDiff.mockResolvedValue(diff({ path: "/another/file" }));
    view.open(); await flush(); h.rows()[0]!.click(); await flush();
    expect(h.node("diff-status").textContent).toMatch(/changed|unavailable/i);
    expect(renderer.setDiff).not.toHaveBeenCalled();
  });
});
