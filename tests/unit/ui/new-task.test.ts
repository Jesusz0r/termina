import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNewTaskComposer } from "../../../src/main/new-task.ts";
import type { PlanTaskCreateResult, TerminaBridge, WorkOverview } from "../../../shared/types.ts";
import { installFakeDom, type FakeEl } from "./fake-dom.ts";

let dom: ReturnType<typeof installFakeDom>;
let composer: ReturnType<typeof createNewTaskComposer>;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { composer?.dispose(); dom.cleanup(); });
function snapshot(): WorkOverview {
  return { items: [], projects: ["/one/same", "/two/same"].map((root, index) => ({
    projectId: `p${index}`, root, name: "same", working: 0, attentionCount: 0, candidateRecoveries: [],
    terminals: [0, 1].map((owner) => ({
      terminalId: `term-${index}-${owner}`, generation: 3, type: "agent", model: null,
      activity: { state: "idle", reason: null }, workArea: { root, workspaceId: `ws${index}`, kind: "project", comparisonId: null },
      planCreationError: owner === 1 ? "Plan Board full" : null,
      verify: null, trackedChanges: 0, tasks: [], attention: [],
      nextAction: { kind: "terminal", terminalId: `term-${index}-${owner}`, generation: 3 },
    })),
  })) };
}
function deferred() {
  let resolve!: (result: PlanTaskCreateResult) => void;
  const promise = new Promise<PlanTaskCreateResult>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(value: WorkOverview | null = snapshot()) {
  const element = dom.document.createElement("div");
  const opener = dom.document.createElement("button");
  dom.document.body.append(element, opener);
  const createPlanTask = vi.fn<TerminaBridge["createPlanTask"]>().mockResolvedValue({ ok: true, task: { text: "Ship outcome", paths: [], state: "pending" } });
  const onCreated = vi.fn();
  composer = createNewTaskComposer({ element: element as unknown as HTMLElement, createPlanTask, onCreated });
  composer.setOverview(value);
  composer.open(undefined, opener as unknown as HTMLElement);
  const form = element.querySelector("form")!;
  const input = element.querySelector("input")!;
  const project = element.querySelector(".overview-task-project")!;
  const board = element.querySelector(".overview-task-board")!;
  const buttons = element.querySelectorAll("button");
  const status = element.querySelector(".overview-task-status")!;
  const draft = () => { input.value = "Ship outcome"; input.dispatch("input"); };
  const submit = () => form.dispatch("submit");
  return { element, opener, form, input, project, board, buttons, status, draft, submit, createPlanTask, onCreated };
}
const content = (node: FakeEl): string => [node.textContent, ...node.children.map(content)].join("\n");
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("inline New task composer", () => {
  it("distinguishes duplicate names, roots and exact board identities; only creates a pending task", async () => {
    const h = harness();
    expect(content(h.project)).toContain("same — /one/same");
    expect(content(h.project)).toContain("same — /two/same");
    expect(content(h.board)).toContain("term-0-0 · /one/same");
    expect(h.board.children.find((option) => option.textContent.includes("Plan Board full"))!.disabled).toBe(true);
    h.project.value = "p1"; h.project.dispatch("change"); h.draft(); h.submit(); await tick();
    expect(h.createPlanTask).toHaveBeenCalledExactlyOnceWith({ projectRoot: "/two/same", text: "Ship outcome", owner: {
      projectId: "p1", workspaceId: "ws1", root: "/two/same", terminalId: "term-1-0", generation: 3,
    } });
    expect(h.onCreated).toHaveBeenCalledOnce();
    expect(h.onCreated.mock.calls[0]![1].state).toBe("pending");
    expect(h.form.hidden).toBe(true);
    expect(dom.document.activeElement).toBe(h.opener);
  });
  it("preserves draft and control focus during canonical refresh", () => {
    const h = harness(); h.draft(); h.board.focus(); composer.setOverview(snapshot());
    expect(h.input.value).toBe("Ship outcome");
    expect(dom.document.activeElement).toBe(h.board);
    expect(h.buttons[0]!.disabled).toBe(false);
    expect(h.createPlanTask).not.toHaveBeenCalled();
  });
  it.each(["owner", "root", "workspace", "generation", "project"])("latches stale %s until explicit fresh choice", (change) => {
    const h = harness(); h.draft(); const value = snapshot(); const project = value.projects[0]!;
    if (change === "owner") project.terminals.shift();
    if (change === "root") project.root = "/changed";
    if (change === "workspace") project.terminals[0]!.workArea!.workspaceId = "new-ws";
    if (change === "generation") project.terminals[0]!.generation++;
    if (change === "project") value.projects.shift();
    composer.setOverview(value); h.submit();
    expect(h.buttons[0]!.disabled).toBe(true); expect(h.status.textContent).toContain("changed");
    expect(h.input.value).toBe("Ship outcome"); expect(h.createPlanTask).not.toHaveBeenCalled();
    composer.setOverview(snapshot()); expect(h.buttons[0]!.disabled).toBe(true);
    h.project.value = "p0"; h.project.dispatch("change"); expect(h.buttons[0]!.disabled).toBe(false);
  });
  it("honestly disables unavailable or ineligible owners without inventing terminals", () => {
    const value = snapshot(); value.projects[0]!.terminals.forEach((owner) => { owner.planCreationError = "Owner busy"; });
    const h = harness(value); h.draft(); h.submit();
    expect(h.status.textContent).toBe("Owner busy"); expect(h.createPlanTask).not.toHaveBeenCalled();
    value.projects[0]!.terminals = []; composer.setOverview(value);
    h.project.dispatch("change"); expect(h.status.textContent).toContain("No existing agent");
    composer.setOverview(null); expect(h.buttons[0]!.disabled).toBe(true);
  });
  it("requests explicit board selection when an owner arrives after the initial project snapshot", () => {
    const initial = snapshot(); initial.projects[0]!.terminals = [];
    const h = harness(initial); h.draft();
    expect(h.status.textContent).toContain("No existing agent");
    composer.setOverview(snapshot());
    expect(h.status.textContent).toBe("Choose an existing agent Plan Board.");
    expect(h.buttons[0]!.disabled).toBe(true); expect(h.input.value).toBe("Ship outcome");
    expect(h.createPlanTask).not.toHaveBeenCalled();
    h.board.value = h.board.children.find((option) => option.value && !option.disabled)!.value;
    h.board.dispatch("change");
    expect(h.buttons[0]!.disabled).toBe(false);
    expect(h.status.textContent).toContain("Creates a pending Plan Board task");
  });
  it.each(["cancel", "escape"])("%s before submit creates nothing and restores the opener", (action) => {
    const h = harness(); h.draft();
    const bubble = vi.fn(); h.element.addEventListener("keydown", bubble);
    if (action === "cancel") h.buttons[1]!.click(); else h.input.dispatch("keydown", { key: "Escape" });
    expect(h.form.hidden).toBe(true); expect(h.createPlanTask).not.toHaveBeenCalled();
    expect(dom.document.activeElement).toBe(h.opener); expect(bubble).not.toHaveBeenCalled();
  });
  it("coalesces queued requests and disables cancellation until authoritative completion", async () => {
    const h = harness(); const queued = deferred(); h.createPlanTask.mockReturnValue(queued.promise);
    h.draft(); h.submit(); h.submit();
    expect(h.createPlanTask).toHaveBeenCalledOnce(); expect(h.status.textContent).toContain("queued");
    expect([h.project, h.board, h.input, ...h.buttons].every((control) => control.disabled)).toBe(true);
    h.buttons[1]!.click(); h.input.dispatch("keydown", { key: "Escape" }); expect(h.form.hidden).toBe(false);
    queued.resolve({ ok: false, error: "Canonical owner unavailable" }); await tick();
    expect(h.status.textContent).toBe("Canonical owner unavailable"); expect(h.input.value).toBe("Ship outcome");
    expect(h.buttons[1]!.disabled).toBe(false);
    h.createPlanTask.mockResolvedValue({ ok: true, task: { text: "Ship outcome", state: "pending", paths: [] } });
    h.submit(); await tick(); expect(h.createPlanTask).toHaveBeenCalledTimes(2); expect(h.onCreated).toHaveBeenCalledOnce();
  });
  it.each(["close", "dispose", "open"])("fences late results after %s", async (action) => {
    const h = harness(); const queued = deferred(); h.createPlanTask.mockReturnValue(queued.promise); h.draft(); h.submit();
    if (action === "close") composer.close();
    if (action === "dispose") composer.dispose();
    if (action === "open") { composer.open("p1"); h.input.value = "New draft"; }
    queued.resolve({ ok: true, task: { text: "Ship outcome", state: "pending", paths: [] } }); await tick();
    expect(h.onCreated).not.toHaveBeenCalled();
    if (action === "open") { expect(h.form.hidden).toBe(false); expect(h.input.value).toBe("New draft"); }
    else expect(h.form.hidden).toBe(true);
  });
});
