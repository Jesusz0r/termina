import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectOverview } from "../../../src/main/project-overview.ts";
import { projectWorkSummary, workOverview, type WorkSummaryTerminalFacts } from "../../../electron/main/work-summary.ts";
import { searchWork } from "../../../src/main/work-search.ts";
import type { TerminaBridge, WorkOverview } from "../../../shared/types.ts";
import { installFakeDom, type FakeEl } from "./fake-dom.ts";

let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createProjectOverview>;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { view?.dispose(); dom.cleanup(); });
const text = (node: FakeEl): string => [node.textContent, ...node.children.map(text)].join("\n");

function terminal(id: string, overrides: Partial<WorkSummaryTerminalFacts> = {}): WorkSummaryTerminalFacts {
  return {
    id, generation: 4, type: "agent", model: "provider/model", activity: { state: "idle", reason: null },
    workspace: { id: "ws-1", root: "/projects/first", primary: true },
    verify: { state: "untested", command: null, summary: null }, dispatchAssignment: null, trackedChanges: 0, plan: [], planCreationError: null, planStartOwnerError: null, ...overrides,
  };
}
function overview(facts = [terminal("term-1", { plan: [{ text: "Repair the parser", paths: ["parser.ts"], state: "pending" }] })]): WorkOverview {
  for (const owner of facts) for (const task of owner.plan) {
    const worker = facts.find((entry) => entry.id === task.workerId);
    if (worker) worker.dispatchAssignment = { ownerId: owner.id, taskText: task.text };
  }
  return workOverview([
    projectWorkSummary({ id: "p1", cwd: "/projects/same-name" }, facts),
    projectWorkSummary({ id: "p2", cwd: "/other/same-name" }, [terminal("term-2", { type: "shell" })]),
  ]);
}
function harness(value = overview()) {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const onNavigate = vi.fn();
  const onNewProject = vi.fn();
  const onSelectionChange = vi.fn();
  const onProjectFilterChange = vi.fn();
  const getVerifyReport = vi.fn(async (_id: string, _generation: number): Promise<string | null> => "Canonical check output");
  const getReviewFiles = vi.fn<TerminaBridge["getReviewFiles"]>().mockResolvedValue({ ok: true, files: [], total: 0 });
  const getReviewDiff = vi.fn<TerminaBridge["getReviewDiff"]>().mockResolvedValue({ ok: false, error: "Baseline unavailable" });
  const releaseTerminal = vi.fn();
  const onFocusTerminal = vi.fn<Parameters<typeof createProjectOverview>[0]["onFocusTerminal"]>().mockResolvedValue(releaseTerminal);
  const onFocusChange = vi.fn();
  const onTerminalControl = vi.fn().mockResolvedValue({ ok: true });
  const onCandidateRecovery = vi.fn();
  const createPlanTask = vi.fn<TerminaBridge["createPlanTask"]>().mockResolvedValue({ ok: false, error: "Fixture rejection" });
  const onTaskCreated = vi.fn();
  const startPlanTask = vi.fn<TerminaBridge["startPlanTask"]>().mockResolvedValue({ ok: true, dispatched: 1 });
  view = createProjectOverview({ element: element as unknown as HTMLElement, onNavigate, onNewProject, onSelectionChange,
    getVerifyReport, getReviewFiles, getReviewDiff, onFocusTerminal, onFocusChange,
    onTerminalControl, onCandidateRecovery, onCandidateInspect: vi.fn(), createPlanTask, startPlanTask, onTaskCreated, onProjectFilterChange });
  view.render(value);
  const filter = element.querySelector("input")!;
  const lanes = () => element.querySelectorAll(".overview-project");
  const cards = () => element.querySelectorAll(".overview-work-card");
  return { element, filter, lanes, cards, onNavigate, onNewProject, onSelectionChange, onProjectFilterChange, getVerifyReport, onFocusTerminal, onFocusChange, releaseTerminal, onTerminalControl, onCandidateRecovery, onCandidateInspect: vi.fn(), createPlanTask, startPlanTask, onTaskCreated,
    inspector: element.querySelector(".overview-work-inspector")!,
    primary: () => element.querySelector(".overview-inspector-primary")!,
    search: (query: string) => { filter.value = query; filter.dispatch("input"); } };
}

describe("real project overview", () => {
  it("filters exact same-name project lanes without changing search, facts or selected work", () => {
    const value = overview(); const before = JSON.stringify(value); const h = harness(value);
    h.cards()[0]!.querySelector("button")!.click();
    h.search("same-name");
    expect(view.setProjectFilter("p2")).toBe(true);
    expect(h.lanes()).toHaveLength(1); expect(h.lanes()[0]!.dataset.projectId).toBe("p2");
    expect(h.filter.value).toBe("same-name"); expect(text(h.element.querySelector(".overview-project-filter")!)).toContain("/other/same-name");
    expect(text(h.element.querySelector(".overview-project-filter")!)).toContain("Attention remains global");
    expect(h.inspector.querySelector(".overview-inspector-title")!.textContent).toBe("Repair the parser");
    expect(h.onProjectFilterChange).toHaveBeenLastCalledWith("p2");
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.createPlanTask).not.toHaveBeenCalled(); expect(h.startPlanTask).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).toBe(before);
    h.element.querySelector(".overview-clear-project-filter")!.click();
    expect(h.lanes()).toHaveLength(2); expect(h.filter.value).toBe("same-name");
    expect(h.onProjectFilterChange).toHaveBeenLastCalledWith(null); expect(dom.document.activeElement).toBe(h.filter);
  });

  it.each(["closed", "root"])("keeps a %s filtered project explicitly invalid until an explicit project choice", (change) => {
    const value = overview(); const h = harness(value); expect(view.setProjectFilter("p1")).toBe(true);
    const changed = structuredClone(value);
    if (change === "closed") changed.projects.shift(); else changed.projects[0]!.root = "/replacement/same-name";
    view.render(changed);
    expect(h.lanes()).toHaveLength(0);
    expect(text(h.element)).toContain("filtered project changed or closed");
    expect(text(h.element.querySelector(".overview-project-filter")!)).toContain("/projects/same-name");
    expect(h.onNavigate).not.toHaveBeenCalled();
    const opener = h.element.querySelector(".overview-new-task")!;
    expect(opener.disabled).toBe(true); opener.click();
    expect(h.element.querySelector(".overview-task-composer")!.hidden).toBe(true);
    expect(h.createPlanTask).not.toHaveBeenCalled();
    expect(view.setProjectFilter("p2")).toBe(true); expect(h.lanes()[0]!.dataset.projectId).toBe("p2");
  });

  it("rejects missing or unavailable filters without altering the current projection", () => {
    const h = harness(); view.setProjectFilter("p1"); h.search("parser");
    const before = text(h.element);
    expect(view.setProjectFilter("missing")).toBe(false); expect(text(h.element)).toBe(before);
    view.setUnavailable(); expect(view.setProjectFilter("p2")).toBe(false);
    expect(h.filter.value).toBe("parser"); expect(h.lanes()[0]!.dataset.projectId).toBe("p1");
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("reveals an explicit global task jump beyond the rail filter without activating or executing", () => {
    const value = overview(); const h = harness(value); view.setProjectFilter("p2"); h.search("nothing matches");
    const result = searchWork(value, "Repair").rows[0]!;
    if (result.target.kind !== "task") throw new Error("Expected task result");
    expect(view.selectTask(result.target.task)).toBe(true);
    expect(h.onProjectFilterChange).toHaveBeenLastCalledWith(null); expect(h.filter.value).toBe("");
    expect(h.lanes()).toHaveLength(2); expect(h.inspector.querySelector(".overview-inspector-title")!.textContent).toBe("Repair the parser");
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.startPlanTask).not.toHaveBeenCalled();
  });

  it("uses the filtered project for global New task without retargeting an existing draft", () => {
    const h = harness(); h.cards()[0]!.querySelector("button")!.click(); view.setProjectFilter("p2");
    h.element.querySelector(".overview-new-task")!.click();
    const form = h.element.querySelector(".overview-task-composer")!;
    expect(form.querySelector(".overview-task-project")!.value).toBe("p2");
    const input = form.querySelector("input")!; input.value = "Draft for p2"; input.dispatch("input");
    view.setProjectFilter("p1");
    expect(form.querySelector(".overview-task-project")!.value).toBe("p2"); expect(input.value).toBe("Draft for p2");
    expect(h.createPlanTask).not.toHaveBeenCalled(); expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it.each(["p1", "p2"])("opens the existing composer for contextual project %s, not the selected card", (projectId) => {
    const h = harness(); h.cards()[0]!.querySelector("button")!.click();
    const lane = h.lanes().find((entry) => entry.dataset.projectId === projectId)!;
    const opener = lane.querySelector(".overview-new-project-task")!;
    expect(opener.getAttribute("aria-describedby")).toBe(lane.querySelector(".overview-project-path")!.id);
    expect(opener.getAttribute("aria-controls")).toBe("overview-new-task-form");
    opener.click();
    const form = h.element.querySelector(".overview-task-composer")!;
    expect(form.hidden).toBe(false);
    expect(form.querySelector(".overview-task-project")!.value).toBe(projectId);
    expect(text(form)).toContain(projectId === "p1" ? "/projects/same-name" : "/other/same-name");
    expect(dom.document.activeElement).toBe(form.querySelector("input"));
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.createPlanTask).not.toHaveBeenCalled();
    expect(h.startPlanTask).not.toHaveBeenCalled(); expect(h.onFocusTerminal).not.toHaveBeenCalled();
    if (projectId === "p2") {
      expect(form.querySelector(".overview-task-actions")!.querySelectorAll("button")[0]!.disabled).toBe(true);
      expect(text(form)).toContain("No existing agent");
    }
    form.querySelector("input")!.dispatch("keydown", { key: "Escape" });
    expect(form.hidden).toBe(true); expect(dom.document.activeElement).toBe(opener);
    opener.click(); form.querySelector(".overview-task-actions")!.querySelectorAll("button")[1]!.click();
    expect(form.hidden).toBe(true); expect(dom.document.activeElement).toBe(opener);
  });

  it("keeps a contextual draft fenced when its destination closes without retargeting another project", () => {
    const value = overview(); const h = harness(value);
    h.lanes()[0]!.querySelector(".overview-new-project-task")!.click();
    const form = h.element.querySelector(".overview-task-composer")!;
    const input = form.querySelector("input")!; input.value = "Draft for the original project"; input.dispatch("input");
    view.render({ projects: value.projects.slice(1), items: [] });
    expect(form.querySelector(".overview-task-project")!.value).toBe("p1");
    expect(input.value).toBe("Draft for the original project");
    expect(form.querySelector(".overview-task-actions")!.querySelectorAll("button")[0]!.disabled).toBe(true);
    expect(text(form)).toMatch(/unavailable|changed/i);
    form.dispatch("submit");
    expect(h.createPlanTask).not.toHaveBeenCalled(); expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("reveals a global task jump beyond the local filter and first page without executing work", () => {
    const value = overview([terminal("owner", { plan: Array.from({ length: 72 }, (_, index) => ({
      text: `Saved task ${index}`, paths: [], state: "pending",
    })) })]);
    const h = harness(value);
    h.search("Nothing matches"); expect(h.cards()).toHaveLength(0);
    const row = searchWork(value, "Saved task 71").rows[0]!;
    if (row.target.kind !== "task") throw new Error("Expected task result");
    expect(view.selectTask(row.target.task)).toBe(true);
    expect(h.filter.value).toBe("");
    const selected = h.cards().find((card) => card.classList.contains("is-selected"))!;
    expect(text(selected)).toContain("Saved task 71");
    expect(selected.lastScrollIntoView).toEqual({ block: "nearest" });
    expect(h.inspector.querySelector(".overview-inspector-title")!.textContent).toBe("Saved task 71");
    expect(dom.document.activeElement).toBe(h.inspector.querySelector(".overview-inspector-title"));
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.onFocusTerminal).not.toHaveBeenCalled();
    expect(h.onTerminalControl).not.toHaveBeenCalled();
  });

  it("rejects a stale global selection without clearing the current inspector or local filter", () => {
    const value = overview(); const h = harness(value);
    h.cards()[0]!.querySelector("button")!.click(); h.search("parser");
    const row = searchWork(value, "Repair").rows[0]!;
    if (row.target.kind !== "task") throw new Error("Expected task result");
    expect(view.selectTask({ ...row.target.task, scope: "changed" })).toBe(false);
    expect(h.filter.value).toBe("parser"); expect(h.inspector.hidden).toBe(false);
    expect(h.inspector.querySelector(".overview-inspector-title")!.textContent).toBe("Repair the parser");
    view.setUnavailable(); expect(view.selectTask(row.target.task)).toBe(false);
  });
  it.each(["open", "discard"] as const)("projects terminal-less %s recovery without a fabricated task or terminal", (recovery) => {
    const value = overview([]);
    const candidate = { comparisonId: "cmp-failed", label: "B" as const, root: "/worlds/failed-B", version: 9,
      error: "The candidate session failed to start", recovery };
    value.projects[0]!.candidateRecoveries = [candidate];
    const before = JSON.stringify(value);
    const h = harness(value);
    const card = h.cards()[0]!;
    expect(text(card)).toContain("Candidate B · startup recovery");
    card.querySelector("button")!.click();
    expect(text(h.inspector)).toContain(candidate.root);
    expect(text(h.inspector)).toContain(candidate.error);
    expect(text(h.inspector)).toContain("No live candidate terminal");
    expect(h.primary().textContent).toBe(recovery === "open" ? "Open candidate recovery" : "Open discard controls");
    for (const name of ["focus", "terminal", "plan", "check", "inspect-changes", "interrupt", "close-terminal"]) {
      expect(h.inspector.querySelector(`.overview-inspector-${name}`)!.hidden).toBe(true);
    }
    h.primary().click();
    expect(h.onCandidateRecovery).toHaveBeenCalledExactlyOnceWith("p1", candidate);
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.onFocusTerminal).not.toHaveBeenCalled();
    expect(h.onTerminalControl).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).toBe(before);
    view.render(overview([]));
    expect(h.primary().disabled).toBe(true);
    h.primary().click();
    expect(h.onCandidateRecovery).toHaveBeenCalledOnce();
  });

  it("leaves Focus for contextual navigation without losing the selected task or filter", async () => {
    const h = harness(overview([terminal("context")]));
    h.cards()[0]!.querySelector("button")!.click();
    h.search("context");
    h.inspector.querySelector(".overview-inspector-focus")!.click(); await Promise.resolve();
    view.leaveFocus();
    expect(h.releaseTerminal).toHaveBeenCalledOnce();
    expect(h.filter.value).toBe("context");
    expect(h.cards()[0]!.classList.contains("is-selected")).toBe(true);
    expect(h.inspector.hidden).toBe(false);
  });

  it("groups real plans by exact project identity, including tasks without attention", () => {
    const h = harness();
    expect(h.lanes().map((lane) => lane.dataset.projectId)).toEqual(["p1", "p2"]);
    expect(text(h.lanes()[0]!)).toContain("/projects/same-name");
    expect(text(h.lanes()[1]!)).toContain("/other/same-name");
    expect(text(h.element)).toContain("1 Plan Board task");
    expect(text(h.cards()[0]!)).toContain("Repair the parser");
    expect(text(h.cards()[0]!)).toContain("Marked pending");
    expect(text(h.cards()[0]!)).toContain("No live worker assigned");
    expect(text(h.cards()[0]!)).not.toMatch(/completed|reviewed|safe|sandbox/i);
    expect(text(h.cards()[1]!)).toContain("Shell activity unknown");
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("uses live source-fenced workers, model overrides and historical outcomes without rewriting task state", () => {
    const h = harness(overview([
      terminal("owner", { plan: [
        { text: "Worker task", paths: [], state: "pending", workerId: "worker", model: "specific/model" },
        { text: "Incomplete attempt", paths: [], state: "pending", dispatchResult: { workerId: "old-worker", outcome: "incomplete" } },
        { text: "Marked task", paths: [], state: "done" },
      ] }),
      terminal("worker", { activity: { state: "working", reason: null } }),
    ]));
    const cards = h.cards();
    expect(text(cards[0]!)).toContain("working · worker worker");
    expect(text(cards[0]!)).toContain("specific/model");
    cards[0]!.querySelector("button")!.click();
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(text(h.inspector)).toContain("working · worker worker");
    h.primary().click();
    expect(h.onNavigate).toHaveBeenLastCalledWith("p1", { kind: "terminal", terminalId: "worker", generation: 4 });
    expect(text(cards[1]!)).toContain("Previous attempt incomplete");
    expect(text(cards[1]!)).toContain("Task attempt incomplete");
    expect(text(cards[2]!)).toContain("Marked done");
    expect(text(cards[2]!)).not.toContain("verified");
    // A worker already represented by its assignment is not a second fake task.
    expect(cards.map(text).filter((value) => value.includes("Agent · worker"))).toHaveLength(0);
  });

  it("separates a task's declared model pin from the effective worker's current model", () => {
    const h = harness(overview([terminal("owner", { model: "provider/owner", plan: [{ text: "Pinned task", state: "active",
      paths: [], model: "provider/planned", workerId: "worker" }] }), terminal("worker", { model: "provider/current" })]));
    h.cards()[0]!.querySelector("button")!.click();
    expect(text(h.inspector)).toContain("worker · provider/current");
    expect(text(h.inspector)).toContain("Task model pin provider/planned");
    expect(text(h.inspector)).not.toContain("worker · provider/planned");
  });

  it("preserves candidate assignment, outdated evidence and cumulative tracked changes as separate facts", () => {
    const h = harness(overview([terminal("candidate", {
      workspace: { id: "candidate-ws", root: "/worlds/alternative", primary: false, comparisonId: "comparison" },
      verify: { state: "stale", command: "pnpm test", summary: "source moved", result: { state: "pass", exitCode: 0, startedAt: 1, finishedAt: 2 } },
      trackedChanges: 7,
    })]));
    const card = h.cards()[0]!;
    expect(text(card)).toContain("Separate candidate tree · /worlds/alternative");
    expect(text(card)).toContain("Check: Outdated");
    expect(text(card)).toContain("historical pass");
    expect(text(card)).toContain("7 tracked paths");
    expect(text(card)).not.toContain("Check: pass");
    card.querySelector("button")!.click();
    expect(text(h.inspector)).toContain("Separate candidate tree · /worlds/alternative");
    expect(h.primary().textContent).toBe("Check details");
    expect(h.onNavigate).not.toHaveBeenCalled();
    h.inspector.querySelector(".overview-inspector-terminal")!.click();
    expect(h.onNavigate).toHaveBeenLastCalledWith("p1", { kind: "terminal", terminalId: "candidate", generation: 4 });
  });

  it("describes repeated actions with their owner and full work area, and opens exact same-name projects", () => {
    const h = harness();
    const descriptions = h.cards().map((card) => card.querySelector(".overview-work-context")!);
    expect(new Set(descriptions.map((node) => node.id)).size).toBe(2);
    h.cards().forEach((card, index) => {
      expect(card.querySelector("button")!.getAttribute("aria-describedby")).toBe(`${card.querySelector("h4")!.id} ${descriptions[index]!.id}`);
    });
    h.lanes()[1]!.querySelector(".overview-open-project")!.click();
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("p2", null);
  });

  it("filters project paths and task text locally without fetching or mutating attention", () => {
    const value = overview();
    const before = JSON.stringify(value);
    const h = harness(value);
    h.filter.focus();
    h.search("parser");
    expect(h.lanes().map((lane) => lane.dataset.projectId)).toEqual(["p1"]);
    expect(h.cards()).toHaveLength(1);
    h.search("/other/");
    expect(h.lanes().map((lane) => lane.dataset.projectId)).toEqual(["p2"]);
    h.search("not present");
    expect(h.lanes()).toHaveLength(0);
    expect(text(h.element)).toContain("No projects or tasks match");
    h.search("");
    expect(h.lanes()).toHaveLength(2);
    expect(dom.document.activeElement).toBe(h.filter);
    expect(JSON.stringify(value)).toBe(before);
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("updates facts and canonical order without replacing focused controls", () => {
    const h = harness();
    const button = h.cards()[0]!.querySelector("button")!;
    button.focus();
    const next = overview([terminal("term-1", { plan: [{ text: "Repair the parser", paths: ["parser.ts"], state: "done" }] })]);
    next.projects.reverse();
    view.render(next);
    expect(h.lanes().map((lane) => lane.dataset.projectId)).toEqual(["p2", "p1"]);
    expect(h.cards()[1]!.querySelector("button")).toBe(button);
    expect(text(h.cards()[1]!)).toContain("Marked done");
    expect(dom.document.activeElement).toBe(button);
    button.click();
    expect(h.onNavigate).not.toHaveBeenCalled();
    h.primary().click();
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("p1", { kind: "plan", terminalId: "term-1", generation: 4 });
  });

  it("removes closed projects and obsolete generations, recovering focus to the filter only when necessary", () => {
    const h = harness();
    h.cards()[0]!.querySelector("button")!.focus();
    const next = overview([terminal("term-1", { generation: 5 })]);
    next.projects = next.projects.filter((project) => project.projectId !== "p2");
    view.render(next);
    expect(h.lanes().map((lane) => lane.dataset.projectId)).toEqual(["p1"]);
    expect(text(h.element)).not.toContain("Repair the parser");
    expect(dom.document.activeElement).toBe(h.filter);
    h.cards()[0]!.querySelector("button")!.click();
    expect(h.onNavigate).not.toHaveBeenCalled();
    h.primary().click();
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("p1", { kind: "terminal", terminalId: "term-1", generation: 5 });
  });

  it("bounds each project to 50 cards, reveals more explicitly and retains focused stable nodes", () => {
    const tasks = Array.from({ length: 72 }, (_, index) => ({ text: `Task ${index}`, paths: [], state: "pending" as const }));
    const value = overview([terminal("owner", { plan: tasks })]);
    value.projects = value.projects.slice(0, 1);
    const h = harness(value);
    expect(h.cards()).toHaveLength(50);
    const first = h.cards()[0]!;
    const more = h.lanes()[0]!.querySelector(".overview-more")!;
    expect(more.hidden).toBe(false);
    more.focus(); more.click();
    expect(h.cards()).toHaveLength(72);
    expect(h.cards()[0]).toBe(first);
    expect(more.hidden).toBe(true);
    expect(dom.document.activeElement).toBe(h.cards()[50]!.querySelector("button"));
  });

  it("shows progressive empty guidance only for an empty workspace, never for a search with no matches", () => {
    const h = harness({ projects: [], items: [] });
    const onboarding = h.element.querySelector(".overview-onboarding")!;
    expect(onboarding.hidden).toBe(false); expect(h.element.querySelector(".overview-empty")!.hidden).toBe(true);
    expect(onboarding.querySelectorAll("li").map((step) => step.querySelector("h4")!.textContent)).toEqual([
      "Open a project", "Connect in the terminal", "Describe an outcome",
    ]);
    expect(text(onboarding)).toContain("/login"); expect(text(onboarding)).toContain("Already connected? Skip this step.");
    expect(onboarding.querySelectorAll("button")).toHaveLength(1);
    expect(h.lanes()).toHaveLength(0); expect(h.cards()).toHaveLength(0);
    expect(h.onNavigate).not.toHaveBeenCalled(); expect(h.createPlanTask).not.toHaveBeenCalled();
    view.render(overview()); h.search("nothing matches");
    expect(onboarding.hidden).toBe(true); expect(h.element.querySelector(".overview-empty")!.hidden).toBe(false);
    expect(h.element.querySelector(".overview-empty")!.textContent).toContain("No projects or tasks match");
    expect(h.element.querySelector(".overview-new-project")!.hidden).toBe(true);
  });

  it("offers the existing project-opening path for an empty workspace and never fabricates tasks", () => {
    const h = harness({ projects: [], items: [] });
    expect(h.lanes()).toHaveLength(0);
    expect(text(h.element)).toContain("Open a project to see its work");
    h.element.querySelector(".overview-new-project")!.click();
    expect(h.onNewProject).toHaveBeenCalledOnce();
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("selects a whole card in place, exposes its expansion and never mutates attention", () => {
    const value = overview([terminal("owner", { plan: [{ text: "Needs recovery", paths: ["parser.ts"], state: "pending",
      dispatchResult: { workerId: "old", outcome: "incomplete" } }] })]);
    const before = JSON.stringify(value);
    const h = harness(value);
    expect(h.inspector.hidden).toBe(true);
    const card = h.cards()[0]!;
    card.querySelector("h4")!.click();
    expect(h.inspector.hidden).toBe(false);
    expect(card.classList.contains("is-selected")).toBe(true);
    expect(card.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    expect(card.querySelector("button")!.getAttribute("aria-controls")).toBe(h.inspector.id);
    expect(dom.document.activeElement).toBe(h.inspector.querySelector(".overview-inspector-title"));
    expect(text(h.inspector)).toContain("Previous attempt incomplete");
    expect(text(h.inspector)).toContain("Declared task paths");
    expect(text(h.inspector)).toContain("parser.ts");
    expect(h.lanes()).toHaveLength(2);
    expect(h.getVerifyReport).not.toHaveBeenCalled();
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(JSON.stringify(value)).toBe(before);
  });

  it("retains the selected task across reordered plans and projects without stealing focus on refresh", () => {
    const facts = [terminal("owner", { plan: [{ text: "First task", paths: [], state: "pending" },
      { text: "Other task", paths: [], state: "pending" }] })];
    const h = harness(overview(facts));
    const selected = h.cards()[0]!;
    selected.querySelector("button")!.click();
    h.filter.focus();
    const next = overview([terminal("owner", { plan: [{ text: "Other task", paths: [], state: "pending" },
      { text: "First task", paths: [], state: "done" }] })]);
    next.projects.reverse();
    view.render(next);
    expect(h.inspector.querySelector(".overview-inspector-title")!.textContent).toBe("First task");
    expect(text(h.inspector)).toContain("Marked done");
    expect(h.cards()[2]).toBe(selected);
    expect(selected.classList.contains("is-selected")).toBe(true);
    expect(dom.document.activeElement).toBe(h.filter);
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("does not collapse repeated Plan Board task text into one card", () => {
    const h = harness(overview([terminal("owner", { plan: [{ text: "Repeated", paths: [], state: "pending" },
      { text: "Repeated", paths: [], state: "done" }] })]));
    expect(h.cards()).toHaveLength(3);
    expect(new Set(h.cards().map((card) => card.dataset.key)).size).toBe(3);
    h.cards()[1]!.querySelector("button")!.click();
    expect(text(h.inspector)).toContain("Marked done");
  });

  it("keeps selected context outside the filter and restores focus safely when its card is hidden", () => {
    const h = harness();
    h.cards()[0]!.querySelector("button")!.click();
    h.filter.focus(); h.search("/other/");
    expect(h.lanes().map((lane) => lane.dataset.projectId)).toEqual(["p2"]);
    expect(h.inspector.hidden).toBe(false);
    expect(h.inspector.querySelector(".overview-inspector-title")!.textContent).toBe("Repair the parser");
    expect(dom.document.activeElement).toBe(h.filter);
    h.inspector.querySelector(".overview-inspector-close")!.click();
    expect(h.inspector.hidden).toBe(true);
    expect(dom.document.activeElement).toBe(h.filter);
    expect(h.onNavigate).not.toHaveBeenCalled();
  });

  it("marks disappeared work unavailable and does not navigate or request stale evidence", () => {
    const h = harness();
    h.cards()[0]!.querySelector("button")!.click();
    view.render(overview([terminal("term-1", { generation: 5 })]));
    expect(h.inspector.querySelector(".overview-inspector-status")!.textContent).toContain("changed or closed");
    expect(h.inspector.querySelector(".overview-inspector-facts")!.hidden).toBe(true);
    expect(h.primary().disabled).toBe(true);
    h.primary().click(); h.inspector.querySelector(".overview-inspector-check")!.click();
    expect(h.onNavigate).not.toHaveBeenCalled();
    expect(h.getVerifyReport).not.toHaveBeenCalled();
    h.inspector.querySelector(".overview-inspector-close")!.click();
    expect(dom.document.activeElement).toBe(h.filter);
  });

  it("can select prior cards during an unavailable overview, but disables inspection until refreshed", () => {
    const h = harness();
    view.setUnavailable();
    h.cards()[0]!.querySelector("button")!.click();
    expect(h.inspector.hidden).toBe(false);
    expect(h.inspector.querySelector(".overview-inspector-status")!.textContent).toContain("overview unavailable");
    expect(h.primary().disabled).toBe(true);
    h.primary().click();
    expect(h.onNavigate).not.toHaveBeenCalled();
    view.render(overview());
    expect(h.primary().disabled).toBe(false);
    expect(h.inspector.querySelector(".overview-inspector-facts")!.hidden).toBe(false);
    h.primary().click();
    expect(h.onNavigate).toHaveBeenCalledExactlyOnceWith("p1", { kind: "plan", terminalId: "term-1", generation: 4 });
  });

  it("handles the first Escape locally and restores its card; only the next Escape reaches the overview owner", () => {
    const h = harness();
    const onParentKey = vi.fn(); dom.document.body.addEventListener("keydown", onParentKey);
    const button = h.cards()[0]!.querySelector("button")!;
    button.click();
    h.inspector.querySelector(".overview-inspector-title")!.dispatch("keydown", { key: "Escape" });
    expect(h.inspector.hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(dom.document.activeElement).toBe(button);
    expect(onParentKey).not.toHaveBeenCalled();
    button.dispatch("keydown", { key: "Escape" });
    expect(onParentKey).toHaveBeenCalledOnce();
  });

  it("focuses the effective worker and returns without losing selection, filter or keyboard focus", async () => {
    const h = harness(overview([
      terminal("owner", { plan: [{ text: "Worker task", paths: [], state: "active", workerId: "worker" }] }), terminal("worker"),
    ]));
    h.cards()[0]!.querySelector("button")!.click();
    h.search("Worker task");
    const focus = h.inspector.querySelector(".overview-inspector-focus")!;
    focus.focus(); focus.click(); await Promise.resolve();
    expect(h.onFocusTerminal).toHaveBeenCalledWith({ projectId: "p1", workspaceId: "ws-1", root: "/projects/first",
      terminalId: "worker", generation: 4 }, expect.anything(), expect.any(Function));
    expect(h.element.querySelector(".overview-work-list")!.hidden).toBe(true);
    expect(h.element.querySelector(".focus-task")!.hidden).toBe(false);
    expect(h.onNavigate).not.toHaveBeenCalled();
    h.element.querySelector(".focus-task-back")!.click();
    expect(h.releaseTerminal).toHaveBeenCalledOnce();
    expect(h.filter.value).toBe("Worker task");
    expect(h.cards()[0]!.classList.contains("is-selected")).toBe(true);
    expect(h.inspector.hidden).toBe(false);
    expect(dom.document.activeElement).toBe(focus);
  });

  it("retains a pending candidate Focus through expected fresh projection events and mounts its real terminal", async () => {
    const value = overview([
      terminal("owner", { plan: [{ text: "Candidate task", paths: ["hello.txt"], state: "active", workerId: "worker" }] }),
      terminal("worker"),
    ]);
    const owner = value.projects[0]!.terminals[0]!;
    const worker = value.projects[0]!.terminals[1]!;
    worker.workArea = { workspaceId: "candidate", root: "/worlds/task-A", kind: "candidate", comparisonId: "cmp" };
    owner.tasks[0]!.task.candidate = { comparisonId: "cmp", label: "A" };
    owner.tasks[0]!.candidate = { comparisonId: "cmp", label: "A", root: "/worlds/task-A", version: 3, state: "running", error: null, headStateId: "captured-result" };
    const h = harness(value);
    const pane = dom.document.createElement("div"); pane.className = "terminal-pane";
    dom.document.body.append(pane);
    let complete!: () => void;
    h.onFocusTerminal.mockImplementationOnce(async (_target, slot, isCurrent) => {
      await new Promise<void>((resolve) => { complete = resolve; });
      if (!isCurrent()) return null;
      (slot as unknown as FakeEl).append(pane);
      return () => { dom.document.body.append(pane); };
    });
    h.cards()[0]!.querySelector("button")!.click();
    h.inspector.querySelector(".overview-inspector-focus")!.click();
    view.render(structuredClone(value));
    expect(h.onFocusTerminal.mock.calls[0]![2]()).toBe(true);
    expect(text(h.element.querySelector(".focus-task")!)).toContain("One task. Full context.");
    expect(text(h.element.querySelector(".focus-task")!)).toContain("worker · /worlds/task-A");
    expect(h.onFocusTerminal.mock.calls[0]![0]).toEqual({ projectId: "p1", workspaceId: "candidate", root: "/worlds/task-A", terminalId: "worker", generation: 4 });
    complete(); await Promise.resolve(); await Promise.resolve();
    expect(h.element.querySelector(".focus-task-terminal")!.children).toContain(pane);
    expect(h.element.querySelector(".focus-task-status")!.textContent).toContain("same running session");
    expect(owner.workArea!.root).toBe("/projects/first");
    h.element.querySelector(".focus-task-back")!.click();
    expect(pane.parentElement).toBe(dom.document.body);
  });

  it("does not substitute the plan owner for an unavailable task worker", () => {
    const h = harness();
    h.cards()[0]!.querySelector("button")!.click();
    const focus = h.inspector.querySelector(".overview-inspector-focus")!;
    expect(focus.disabled).toBe(true);
    focus.click();
    expect(h.onFocusTerminal).not.toHaveBeenCalled();
  });

  it.each(["close", "dispose", "unavailable", "replacement"])("releases a late terminal mount after %s", async (reason) => {
    const h = harness(overview([terminal("context")]));
    let complete!: (value: () => void) => void;
    h.onFocusTerminal.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    h.cards()[0]!.querySelector("button")!.click();
    h.inspector.querySelector(".overview-inspector-focus")!.click();
    const isCurrent = h.onFocusTerminal.mock.calls[0]![2];
    expect(isCurrent()).toBe(true);
    if (reason === "dispose") view.dispose();
    else if (reason === "unavailable") view.setUnavailable();
    else if (reason === "replacement") view.render(overview([terminal("context", { generation: 5 })]));
    else view.clearSelection();
    expect(isCurrent()).toBe(false);
    complete(h.releaseTerminal); await Promise.resolve();
    expect(h.releaseTerminal).toHaveBeenCalledOnce();
    expect(h.element.querySelector(".focus-task")!.hidden).toBe(true);
  });

  it("keeps terminal Escape in the TUI; inspector Escape returns to overview first", async () => {
    const h = harness(overview([terminal("context")]));
    h.cards()[0]!.querySelector("button")!.click();
    h.inspector.querySelector(".overview-inspector-focus")!.click(); await Promise.resolve();
    const onParentKey = vi.fn(); dom.document.body.addEventListener("keydown", onParentKey);
    h.element.querySelector(".focus-task-terminal")!.dispatch("keydown", { key: "Escape" });
    expect(h.element.querySelector(".focus-task")!.hidden).toBe(false);
    expect(onParentKey).toHaveBeenCalledOnce();
    h.inspector.querySelector(".overview-inspector-title")!.dispatch("keydown", { key: "Escape" });
    expect(h.element.querySelector(".focus-task")!.hidden).toBe(true);
    expect(h.inspector.hidden).toBe(false);
    expect(h.releaseTerminal).toHaveBeenCalledOnce();
  });

  it("returns to overview immediately when the focused terminal roster identity disappears", async () => {
    const h = harness(overview([terminal("context")]));
    h.cards()[0]!.querySelector("button")!.click();
    h.inspector.querySelector(".overview-inspector-focus")!.click(); await Promise.resolve();
    view.invalidateChangesForInstances([]);
    expect(h.releaseTerminal).toHaveBeenCalledOnce();
    expect(h.element.querySelector(".focus-task")!.hidden).toBe(true);
    expect(h.inspector.hidden).toBe(false);
  });

  it("removes its listeners on disposal and ignores subsequent render/input/actions", () => {
    const h = harness();
    const button = h.cards()[0]!.querySelector("button")!;
    view.dispose(); view.dispose();
    view.render({ projects: [], items: [] });
    h.search("missing"); button.click();
    expect(h.lanes()).toHaveLength(2);
    expect(h.onNavigate).not.toHaveBeenCalled();
  });
});
