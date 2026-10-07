import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAttentionView } from "../../../src/main/attention-view.ts";
import { searchWork, type WorkSearchTarget } from "../../../src/main/work-search.ts";
import { projectWorkSummary, workOverview } from "../../../electron/main/work-summary.ts";
import type { TerminaBridge, WorkOverview } from "../../../shared/types.ts";
import { installFakeDom, type FakeEl } from "./fake-dom.ts";

function overview(): WorkOverview {
  return workOverview(["first", "other"].map((name, index) => projectWorkSummary({ id: `p${index}`, cwd: `/${name}/same-name` }, [{
    id: `owner-${index}`, generation: 3, type: "agent", model: "provider/model", activity: { state: "idle", reason: null },
    workspace: { id: `ws-${index}`, root: `/${name}/same-name`, primary: true },
    verify: { state: "untested", command: null, summary: null }, trackedChanges: 0, planCreationError: null,
    plan: [{ text: "Repair the parser", paths: ["parser.ts"], state: "pending" }],
  }])));
}
function target(value: WorkOverview): WorkSearchTarget {
  return searchWork(value, "/other Repair").rows[0]!.target;
}
const text = (node: FakeEl): string => [node.textContent, ...node.children.map(text)].join("\n");
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createAttentionView>;
beforeEach(() => { dom = installFakeDom(); vi.useFakeTimers(); });
afterEach(() => { view?.dispose(); vi.useRealTimers(); dom.cleanup(); });
function harness(value = overview()) {
  const element = dom.document.createElement("section"); element.hidden = true;
  for (const id of ["work-view-title", "project-overview", "overview-attention-heading", "attention-list", "attention-status",
    "attention-message", "btn-close-attention", "btn-refresh-attention", "btn-more-attention"]) {
    const node = dom.document.createElement(id.startsWith("btn-") ? "button" : "div"); node.id = id; element.append(node);
  }
  const toggle = dom.document.createElement("button");
  const count = dom.document.createElement("span"); count.className = "attention-count"; toggle.append(count);
  const overviewToggle = dom.document.createElement("button");
  const workspace = dom.document.createElement("div");
  dom.document.body.append(element, toggle, overviewToggle, workspace);
  const callbacks = new Map<string, () => void>();
  const getWorkOverview = vi.fn(async (): Promise<WorkOverview> => value);
  const getVerifyReport = vi.fn().mockResolvedValue(null);
  const getReviewFiles = vi.fn().mockResolvedValue({ ok: true, files: [], total: 0 });
  const getReviewDiff = vi.fn().mockResolvedValue({ ok: false, error: "unavailable" });
  const bridge = { getWorkOverview, getVerifyReport, getReviewFiles, getReviewDiff } as unknown as TerminaBridge;
  for (const hook of ["onInstances", "onPlanUpdate", "onModifiedList", "onFileChanged", "onFileDeleted", "onVerifyState",
    "onTimelineClear", "onFolderOpened", "onProjectClosed", "onAgentStatus", "onTimelinePrefix"] as const) {
    bridge[hook] = ((callback: () => void) => { callbacks.set(hook, callback); return () => {}; }) as never;
  }
  const onNavigate = vi.fn().mockResolvedValue(true);
  const onReveal = vi.fn(); const onOverview = vi.fn();
  const onFocusTerminal = vi.fn().mockResolvedValue(null);
  const onTerminalControl = vi.fn().mockResolvedValue({ ok: true });
  view = createAttentionView({ element: element as unknown as HTMLElement, toggle: toggle as unknown as HTMLButtonElement,
    overviewToggle: overviewToggle as unknown as HTMLButtonElement, workspace: [workspace as unknown as HTMLElement], bridge,
    onOverview, onViewChange: vi.fn(), onInspect: vi.fn().mockResolvedValue(false), onNavigate, onReveal, onNewProject: vi.fn(),
    onFocusTerminal, onTerminalControl, onCandidateRecovery: vi.fn().mockResolvedValue(false), onRevealCandidate: vi.fn() });
  return { element, workspace, getWorkOverview, onNavigate, onReveal, onOverview, onFocusTerminal, onTerminalControl,
    getVerifyReport, getReviewFiles, getReviewDiff, emit: (hook: string) => (callbacks.get(hook)! as (payload: unknown) => void)({ instanceId: "owner-1", projectId: "p1" }),
    inspector: () => element.querySelector("#project-work-inspector")! };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Jump to work navigation", () => {
  it("activates the exact task project, then selects its inspector without worker execution or evidence fetch", async () => {
    const value = overview(); const before = JSON.stringify(value); const h = harness(value); await flush();
    expect(await view.revealWork(target(value), () => true)).toBe(true);
    expect(h.element.hidden).toBe(false); expect(h.workspace.inert).toBe(true);
    expect(text(h.inspector())).toContain("/other/same-name");
    expect(text(h.inspector())).toContain("owner-1");
    expect(h.inspector().querySelector(".overview-inspector-title")!.textContent).toBe("Repair the parser");
    expect(dom.document.activeElement).toBe(h.inspector().querySelector(".overview-inspector-title"));
    expect(h.inspector().querySelector(".overview-inspector-focus")!.disabled).toBe(true);
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("p1", null, expect.any(Function));
    for (const action of [h.onReveal, h.onFocusTerminal, h.onTerminalControl, h.getVerifyReport, h.getReviewFiles, h.getReviewDiff]) {
      expect(action).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each(["generation", "source", "cancel"])("revalidates the task after activation when its %s changes", async (change) => {
    const value = overview(); const h = harness(value); await flush();
    const activating = deferred<boolean>(); h.onNavigate.mockReturnValueOnce(activating.promise);
    let current = true;
    const opening = view.revealWork(target(value), () => current); await flush();
    expect(h.onNavigate).toHaveBeenCalledOnce();
    const next = structuredClone(value);
    if (change === "generation") next.projects[1]!.terminals[0]!.generation++;
    else if (change === "source") next.projects[1]!.terminals[0]!.workArea!.root = "/replaced/source";
    else current = false;
    h.getWorkOverview.mockResolvedValueOnce(next);
    activating.resolve(true);
    expect(await opening).toBe(false);
    expect(h.element.hidden).toBe(true); expect(h.workspace.inert).toBe(false);
    expect(h.onReveal).not.toHaveBeenCalled(); expect(h.onFocusTerminal).not.toHaveBeenCalled();
  });

  it("rechecks project ID and root before delegating only canonical project navigation", async () => {
    const value = overview(); const h = harness(value); await flush();
    const project: WorkSearchTarget = { kind: "project", projectId: "p1", root: "/other/same-name" };
    expect(await view.revealWork({ ...project, root: "/different" }, () => true)).toBe(false);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(await view.revealWork(project, () => true)).toBe(true);
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("p1", null, expect.any(Function));
    expect(h.onReveal).toHaveBeenCalledExactlyOnceWith("p1", null);
    expect(h.element.hidden).toBe(true);
    expect(h.onFocusTerminal).not.toHaveBeenCalled(); expect(h.onTerminalControl).not.toHaveBeenCalled();
  });

  it.each(["removed", "generation", "source", "renamed"])("refuses a task whose %s context no longer matches", async (change) => {
    const value = overview(); const destination = target(value); const h = harness(value); await flush();
    const fresh = structuredClone(value);
    if (change === "removed") fresh.projects.pop();
    else if (change === "generation") fresh.projects[1]!.terminals[0]!.generation++;
    else if (change === "source") fresh.projects[1]!.terminals[0]!.workArea!.root = "/different/source";
    else fresh.projects[1]!.terminals[0]!.tasks[0]!.task.text = "Renamed task";
    h.getWorkOverview.mockResolvedValueOnce(fresh);
    expect(await view.revealWork(destination, () => true)).toBe(false);
    expect(h.element.hidden).toBe(true); expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it.each(["closed project event", "plan update", "external cancel", "close", "dispose"])("rejects a held genuine read after %s", async (change) => {
    const value = overview(); const h = harness(value); await flush();
    const pending = deferred<WorkOverview>(); h.getWorkOverview.mockReturnValueOnce(pending.promise);
    let current = true;
    const opening = view.revealWork(target(value), () => current);
    if (change === "closed project event") h.emit("onProjectClosed");
    else if (change === "plan update") h.emit("onPlanUpdate");
    else if (change === "external cancel") current = false;
    else if (change === "close") view.close(false);
    else view.dispose();
    pending.resolve(value);
    expect(await opening).toBe(false);
    expect(h.element.hidden).toBe(true); expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.workspace.inert).toBe(false);
  });
});
