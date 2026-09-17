import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createActivityPane } from "../../../src/main/activity-pane.ts";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

const toast = vi.hoisted(() => vi.fn());

vi.mock("../../../src/components/modals.ts", () => ({
  toast,
  showConfirm: vi.fn(),
}));

describe("plan board model chip", () => {
  let fake: { document: FakeDocument; cleanup: () => void };
  let dispatchRun: ReturnType<typeof vi.fn>;
  let planList: FakeEl;

  beforeAll(async () => {
    fake = installFakeDom();
    dispatchRun = vi.fn().mockResolvedValue({ ok: true, dispatched: 1 });
    (globalThis as unknown as { window: unknown }).window = {
      termina: {
        dispatchRun,
        getPlan: vi.fn(),
        onPlanUpdate: () => () => {},
        onModifiedList: () => () => {},
      },
    };
  });

  afterAll(() => {
    fake.cleanup();
  });

  function mount(model: string | null = "anthropic/claude-sonnet-4-5") {
    dispatchRun.mockClear();
    const planPanel = fake.document.createElement("section");
    const planHeader = fake.document.createElement("div");
    planHeader.className = "panel-header";
    planPanel.appendChild(planHeader);
    const modifiedPanel = fake.document.createElement("div");
    const modifiedHeader = fake.document.createElement("div");
    modifiedHeader.className = "panel-header";
    modifiedPanel.appendChild(modifiedHeader);
    planList = fake.document.createElement("ul");
    const pane = {
      instanceId: "term-1",
      projectId: "p1",
      workspaceId: "w1",
      model,
      modified: [] as { path: string; relPath: string; status: "modified" }[],
      accepted: new Map<string, number>(),
      reverted: new Set<string>(),
      plan: [
        { text: "Create src/utils.ts", paths: ["src/utils.ts"], state: "pending" as const },
        { text: "Edit greeting.ts @model openai/gpt-5.4", paths: ["greeting.ts"], state: "pending" as const, model: "openai/gpt-5.4" },
      ],
      planLoaded: true,
      planLoadAttempts: 0,
      planVersion: 1,
    };
    const activity = createActivityPane({
      elements: {
        planPanel: planPanel as unknown as HTMLElement,
        planList: planList as unknown as HTMLElement,
        planCount: fake.document.createElement("span") as unknown as HTMLElement,
        btnDispatch: fake.document.createElement("button") as unknown as HTMLButtonElement,
        modifiedList: fake.document.createElement("ul") as unknown as HTMLElement,
        modifiedPanel: modifiedPanel as unknown as HTMLElement,
        modifiedCount: fake.document.createElement("span") as unknown as HTMLElement,
        btnClearModified: fake.document.createElement("button") as unknown as HTMLButtonElement,
        btnAcceptAll: fake.document.createElement("button") as unknown as HTMLButtonElement,
      },
      getActivePane: () => pane,
      getActivePaneId: () => pane.instanceId,
      getPaneById: () => pane,
      getAllPanes: () => [pane],
      onPlanContent: () => {},
      onModifiedContent: () => {},
      onReviewChanged: () => {},
      onModifiedListChanged: () => {},
      onShowWorker: () => {},
      openReview: () => {},
      getRecentModels: () => [{ provider: "xai", model: "grok-4" }],
      getLiveModels: () => ["google/gemini-3.7-flash"],
    });
    activity.renderPlan(pane, false);
    return { pane, activity };
  }

  it("does not dispatch when the model chip is clicked", () => {
    mount();
    const chip = planList.querySelector(".plan-model");
    expect(chip).not.toBeNull();
    chip!.click();
    expect(dispatchRun).not.toHaveBeenCalled();
  });

  it("dispatches inherit by default and the selected pin after a chip change", () => {
    mount();
    const row = planList.querySelector("li");
    expect(row).not.toBeNull();
    row!.click();
    expect(dispatchRun).toHaveBeenCalledWith("term-1", "Create src/utils.ts", "inherit");
    dispatchRun.mockClear();
    const chip = planList.querySelector(".plan-model") as FakeEl;
    chip.value = "xai/grok-4";
    chip.dispatch("change");
    row!.click();
    expect(dispatchRun).toHaveBeenCalledWith("term-1", "Create src/utils.ts", "xai/grok-4");
  });

  it("defaults a row with @model to that pin", () => {
    mount();
    const rows = planList.querySelectorAll("li");
    expect(rows).toHaveLength(2);
    rows[1]!.click();
    expect(dispatchRun).toHaveBeenCalledWith("term-1", "Edit greeting.ts @model openai/gpt-5.4", "openai/gpt-5.4");
  });
});
