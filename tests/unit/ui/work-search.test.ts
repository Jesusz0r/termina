import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickOpen } from "../../../src/quick-open.ts";
import { searchWork, type WorkSearchTarget } from "../../../src/main/work-search.ts";
import { findOverviewTask } from "../../../src/main/project-overview.ts";
import { projectWorkSummary, workOverview, type WorkSummaryTerminalFacts } from "../../../electron/main/work-summary.ts";
import type { WorkOverview } from "../../../shared/types.ts";
import { installFakeDom, type FakeEl } from "./fake-dom.ts";

function facts(id: string, root: string, overrides: Partial<WorkSummaryTerminalFacts> = {}): WorkSummaryTerminalFacts {
  return { id, generation: 3, type: "agent", model: "provider/model", activity: { state: "idle", reason: null },
    workspace: { id: `ws-${root}`, root, primary: true }, verify: { state: "untested", command: null, summary: null },
    trackedChanges: 0, plan: [{ text: "Repair <parser> & tokens", paths: ["parser.ts"], state: "pending" }], planCreationError: null, planStartOwnerError: null, ...overrides };
}
function overview(): WorkOverview {
  return workOverview([
    projectWorkSummary({ id: "p1", cwd: "/first/same-name" }, [facts("owner-1", "/first/same-name"), facts("owner-2", "/first/same-name")]),
    projectWorkSummary({ id: "p2", cwd: "/other/same-name" }, [facts("owner-3", "/other/same-name")]),
  ]);
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("canonical work search", () => {
  it("matches unordered case-insensitive tokens and distinguishes same-name projects and owners", () => {
    const value = overview();
    const before = JSON.stringify(value);
    const { rows } = searchWork(value, "TOKENS repair");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining("/first/same-name · Plan owner owner-1"),
      expect.stringContaining("/first/same-name · Plan owner owner-2"),
      expect.stringContaining("/other/same-name · Plan owner owner-3"),
    ]));
    expect(new Set(rows.map((row) => JSON.stringify(row.target))).size).toBe(3);
    expect(searchWork(value, "same-name").rows.filter((row) => row.target.kind === "project")).toHaveLength(2);
    expect(searchWork(value, "/OTHER same-name repair").rows).toHaveLength(1);
    expect(searchWork(value, "missing").rows).toEqual([]);
    expect(JSON.stringify(value)).toBe(before);
    expect(rows.every((row) => !/completed|reviewed|verified/.test(row.detail))).toBe(true);
  });

  it("includes pending/done tasks without attention, not invented shell or recovery tasks", () => {
    const value = overview();
    const project = projectWorkSummary({ id: "empty", cwd: "/shell" }, [facts("shell", "/shell", { type: "shell", plan: [] })], [
      { comparisonId: "cmp-1", label: "A", root: "/candidate", version: 1, error: "startup failed", recovery: "open" },
    ]);
    value.projects.push({ ...project, working: 0, attentionCount: 0 });
    value.projects[0]!.terminals[0]!.tasks[0]!.task.state = "done";
    expect(value.items).toEqual([]);
    expect(searchWork(value, "").rows).toHaveLength(6);
    expect(searchWork(value, "parser").rows[0]!.detail).toContain("Marked done");
    expect(searchWork(value, "candidate").rows).toEqual([]);
  });

  it("caps result DOM work and discloses truncation without limiting search to the first page", () => {
    const value = workOverview([projectWorkSummary({ id: "p1", cwd: "/large" }, [facts("owner", "/large", {
      plan: Array.from({ length: 75 }, (_, index) => ({ text: `Saved task ${index}`, paths: [], state: "pending" })),
    })])]);
    expect(searchWork(value, "Saved")).toMatchObject({ truncated: true, rows: expect.any(Array) });
    expect(searchWork(value, "Saved").rows).toHaveLength(50);
    expect(searchWork(value, "Saved task 74")).toMatchObject({ truncated: false, rows: [{ label: "Saved task 74" }] });
  });

  it("revalidates project, owner generation, source and declared paths, but not volatile model metadata", () => {
    const value = overview();
    const row = searchWork(value, "repair").rows[0]!;
    if (row.target.kind !== "task") throw new Error("Expected task result");
    const target = row.target.task;
    expect(findOverviewTask(value, target)?.owner.terminalId).toBe("owner-1");
    value.projects[0]!.terminals[0]!.model = "provider/new-model";
    expect(findOverviewTask(value, target)).not.toBeNull();
    for (const change of [
      (next: WorkOverview) => { next.projects[0]!.root = "/replacement"; },
      (next: WorkOverview) => { next.projects[0]!.terminals[0]!.generation++; },
      (next: WorkOverview) => { next.projects[0]!.terminals[0]!.workArea!.workspaceId = "replacement"; },
      (next: WorkOverview) => { next.projects[0]!.terminals[0]!.tasks[0]!.task.paths = ["other.ts"]; },
      (next: WorkOverview) => { next.projects[0]!.terminals.shift(); },
    ]) {
      const next = structuredClone(value); change(next);
      expect(findOverviewTask(next, target)).toBeNull();
    }
  });

  it("fences the effective worker and includes candidate source attribution", () => {
    const root = "/separate/source";
    const value = workOverview([projectWorkSummary({ id: "p", cwd: "/primary" }, [
      facts("owner", root, { workspace: { id: "candidate", root, primary: false, comparisonId: "cmp-1" },
        plan: [{ text: "Worker task", paths: [], state: "active", workerId: "worker" }] }),
      facts("worker", root, { workspace: { id: "candidate", root, primary: false, comparisonId: "cmp-1" }, plan: [] }),
    ])]);
    const row = searchWork(value, "Worker task").rows[0]!;
    expect(row.detail).toContain("Separate candidate tree /separate/source");
    if (row.target.kind !== "task") throw new Error("Expected task result");
    expect(findOverviewTask(value, row.target.task)?.terminal.terminalId).toBe("worker");
    value.projects[0]!.terminals[1]!.generation++;
    expect(findOverviewTask(value, row.target.task)).toBeNull();
  });
});

let dom: ReturnType<typeof installFakeDom>;
let qo: QuickOpen;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { qo?.close(); vi.useRealTimers(); vi.unstubAllGlobals(); dom.cleanup(); });
function mount(pending?: Promise<WorkOverview>) {
  qo = new QuickOpen();
  const getWorkOverview = vi.fn(async () => overview());
  if (pending) getWorkOverview.mockReturnValueOnce(pending);
  const onOpenWork = vi.fn(async (_target: WorkSearchTarget, _isCurrent: () => boolean): Promise<boolean> => true);
  const onExecuteCommand = vi.fn();
  const onOpenFile = vi.fn();
  qo.bind({ onOpenFile, onOpenContentHit: vi.fn(), onContentResults: vi.fn(), onExecuteCommand,
    getShortcut: () => "", onOpenWork });
  vi.stubGlobal("window", { termina: { getWorkOverview } });
  const opener = dom.document.createElement("button");
  dom.document.body.append(opener); opener.focus();
  qo.open("actions");
  const input = dom.modalRoot.querySelector(".search-input")!;
  const root = dom.modalRoot.querySelector(".search-modal")!;
  const search = (query: string) => { input.value = query; input.dispatch("input"); };
  const rows = () => dom.modalRoot.querySelectorAll(".search-hit");
  return { input, root, opener, search, rows, onOpenWork, onOpenFile, onExecuteCommand, getWorkOverview };
}
const text = (node: FakeEl): string => [node.textContent, ...node.children.map(text)].join("\n");

describe("Command Palette work integration", () => {
  it("opens a clicked file after debounce completes rather than flushing an expired timer", async () => {
    vi.useFakeTimers();
    const h = mount(); await flush();
    const searchFiles = vi.fn(async () => ({ entries: [{ relPath: "src/index.ts" }], truncated: false }));
    vi.stubGlobal("window", { termina: { searchFiles } });
    qo.open("files"); await flush();
    h.search("index"); await vi.advanceTimersByTimeAsync(150); await flush();
    expect(h.rows()).toHaveLength(1); h.rows()[0]!.click();
    expect(h.onOpenFile).toHaveBeenCalledExactlyOnceWith("src/index.ts");
    expect(searchFiles).toHaveBeenCalledTimes(2);
    expect(h.root.style.display).toBe("none");
  });
  it("keeps global navigation current during its project activation but closes project-relative search", async () => {
    const h = mount(); await flush(); h.search("/other");
    const opening = deferred<boolean>(); h.onOpenWork.mockReturnValueOnce(opening.promise);
    h.input.dispatch("keydown", { key: "Enter" });
    const isCurrent = h.onOpenWork.mock.calls[0]![1];
    qo.onProjectChange(); expect(isCurrent()).toBe(true); expect(h.root.style.display).toBe("flex");
    opening.resolve(true); await flush(); expect(h.root.style.display).toBe("none");
    qo.open("content"); qo.onProjectChange(); expect(h.root.style.display).toBe("none");
  });
  it("keeps commands usable while loading and searches the latest typed query on arrival", async () => {
    const read = deferred<WorkOverview>();
    const h = mount(read.promise);
    h.search("TOKENS repair");
    expect(h.rows()).toEqual([]);
    expect(dom.modalRoot.querySelector(".search-status")!.textContent).toContain("Loading");
    read.resolve(overview()); await flush();
    expect(h.rows()).toHaveLength(3);
    expect(text(h.rows()[0]!)).toContain("Repair <parser> & tokens");
    expect(h.rows()[0]!.querySelector("parser")).toBeNull();
    h.input.dispatch("keydown", { key: "End" });
    expect(h.rows()[2]!.getAttribute("aria-selected")).toBe("true");
    h.input.dispatch("keydown", { key: "Enter" }); await flush();
    expect(h.onOpenWork).toHaveBeenCalledOnce();
    expect(h.onExecuteCommand).not.toHaveBeenCalled();
    expect(h.root.style.display).toBe("none");
  });

  it("retains the selected result across live updates and removes closed project results", async () => {
    const h = mount(); await flush(); h.search("repair");
    h.input.dispatch("keydown", { key: "End" });
    const before = text(h.rows()[2]!);
    const next = overview(); next.projects[0]!.terminals[0]!.model = "new";
    qo.setWorkOverview(next);
    expect(text(h.rows()[2]!)).toBe(before);
    expect(h.rows()[2]!.getAttribute("aria-selected")).toBe("true");
    next.projects.pop(); qo.setWorkOverview(next);
    expect(h.rows()).toHaveLength(2);
    expect(h.rows().every((row) => !text(row).includes("/other/"))).toBe(true);
  });

  it("keeps the palette open on refused or failed work without executing commands", async () => {
    const h = mount(); await flush(); h.search("repair");
    h.onOpenWork.mockResolvedValueOnce(false);
    h.input.dispatch("keydown", { key: "Enter" }); await flush();
    expect(h.root.style.display).toBe("flex");
    expect(dom.modalRoot.querySelector(".search-status")!.textContent).toContain("changed or closed");
    qo.setWorkOverview(overview());
    expect(dom.modalRoot.querySelector(".search-status")!.textContent).toContain("changed or closed");
    expect(dom.document.activeElement).toBe(h.input);
    h.onOpenWork.mockRejectedValueOnce(new Error("unavailable"));
    h.rows()[0]!.click(); await flush();
    expect(h.root.style.display).toBe("flex");
    expect(dom.modalRoot.querySelector(".search-status")!.textContent).toContain("unavailable");
    expect(h.onExecuteCommand).not.toHaveBeenCalled();
  });

  it.each(["Escape", "query", "close", "mode"])("cancels pending work on %s without late modal dismissal", async (cancel) => {
    const h = mount(); await flush(); h.search("repair");
    const opening = deferred<boolean>(); h.onOpenWork.mockReturnValueOnce(opening.promise);
    h.input.dispatch("keydown", { key: "Enter" });
    const isCurrent = h.onOpenWork.mock.calls[0]![1];
    expect(isCurrent()).toBe(true);
    if (cancel === "Escape") h.input.dispatch("keydown", { key: "Escape" });
    else if (cancel === "query") h.search("same-name");
    else if (cancel === "close") qo.close();
    else qo.open("content");
    expect(isCurrent()).toBe(false);
    opening.resolve(true); await flush();
    if (cancel === "query" || cancel === "mode") expect(h.root.style.display).toBe("flex");
    else { expect(h.root.style.display).toBe("none"); expect(dom.document.activeElement).toBe(h.opener); }
  });

  it("leaves commands available after overview failure and does not dismiss a command's replacement modal", async () => {
    const pending = deferred<WorkOverview>();
    const h = mount(pending.promise);
    h.search("Quick open");
    expect(h.rows()).toHaveLength(1);
    pending.reject(new Error("offline")); await flush();
    expect(dom.modalRoot.querySelector(".search-status")!.textContent).toContain("Commands still available");
    h.onExecuteCommand.mockImplementation(() => qo.open("content"));
    h.input.dispatch("keydown", { key: "Enter" });
    expect(h.onExecuteCommand).toHaveBeenCalledExactlyOnceWith("quick-open");
    expect(h.root.style.display).toBe("flex");
    expect(dom.modalRoot.querySelector(".modal-title")!.textContent).toBe("Search Contents");
  });

  it("ignores older overview reads after a canonical update, cancellation or mode switch", async () => {
    const pending = deferred<WorkOverview>(); const h = mount(pending.promise);
    h.search("repair"); qo.setWorkOverview({ projects: [], items: [] });
    pending.resolve(overview()); await flush(); expect(h.rows()).toEqual([]);
    const late = deferred<WorkOverview>(); h.getWorkOverview.mockReturnValueOnce(late.promise);
    qo.open("actions"); qo.open("content"); late.resolve(overview()); await flush();
    expect(dom.modalRoot.querySelector(".search-status")!.textContent).toContain("regular expression");
    expect(h.rows()).toEqual([]);
  });

  it("discloses capped work results while a refined query finds a later task", async () => {
    const h = mount(); await flush();
    const value = overview();
    value.projects[0]!.terminals[0]!.tasks = Array.from({ length: 80 }, (_, index) => ({
      task: { text: `Saved task ${index}`, paths: [], state: "pending" }, worker: null, attention: [], startError: null,
      nextAction: { kind: "plan", terminalId: "owner-1", generation: 3 },
    }));
    qo.setWorkOverview(value); h.search("Saved");
    expect(h.rows()).toHaveLength(50);
    expect(dom.modalRoot.querySelector(".search-status")!.textContent).toContain("Refine");
    h.search("Saved task 79"); expect(h.rows()).toHaveLength(1);
    expect(text(h.rows()[0]!)).toContain("Saved task 79");
  });
});
