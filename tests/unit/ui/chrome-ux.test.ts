import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { applyEmptyStateShortcutHints, formatShortcut } from "../../../src/settings-shortcuts.ts";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

const showConfirm = vi.hoisted(() => vi.fn());

vi.mock("../../../src/components/modals.ts", () => ({
  toast: vi.fn(),
  showConfirm,
}));

type ActivityPane = typeof import("../../../src/main/activity-pane.ts");

const html = readFileSync(new URL("../../../src/index.html", import.meta.url), "utf8");
const mainSrc = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const editorSrc = readFileSync(new URL("../../../src/editor.ts", import.meta.url), "utf8");
const activitySrc = readFileSync(new URL("../../../src/main/activity-pane.ts", import.meta.url), "utf8");

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");

function setPlatform(platform: string): void {
  Object.defineProperty(navigator, "platform", { configurable: true, value: platform });
}

function restorePlatform(): void {
  if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
}

describe("empty-state shortcut hints", () => {
  afterAll(() => {
    restorePlatform();
  });

  function hintRoot(document: FakeDocument): { root: FakeEl; modifier: FakeEl } {
    const root = document.createElement("div");
    const modifier = document.createElement("kbd");
    modifier.setAttribute("data-shortcut-mod", "");
    modifier.textContent = "⌘";
    const key = document.createElement("kbd");
    key.textContent = "O";
    root.append(modifier, key);
    return { root, modifier };
  }

  it("rewrites the open-folder modifier to Ctrl on non-Mac", () => {
    const { document, cleanup } = installFakeDom();
    try {
      setPlatform("Linux x86_64");
      expect(formatShortcut("CmdOrCtrl+O")).toBe("Ctrl+O");
      const { root, modifier } = hintRoot(document);
      applyEmptyStateShortcutHints(root as unknown as ParentNode);
      expect(modifier.textContent).toBe("Ctrl");
      expect(modifier.textContent).not.toBe("⌘");
    } finally {
      cleanup();
    }
  });

  it("keeps the open-folder modifier as ⌘ on Mac", () => {
    const { document, cleanup } = installFakeDom();
    try {
      setPlatform("MacIntel");
      expect(formatShortcut("CmdOrCtrl+O")).toBe("⌘O");
      const { root, modifier } = hintRoot(document);
      modifier.textContent = "Ctrl";
      applyEmptyStateShortcutHints(root as unknown as ParentNode);
      expect(modifier.textContent).toBe("⌘");
    } finally {
      cleanup();
    }
  });

  it("rewrites cloned empty-state markup at the editor and boot clone sites", () => {
    expect(html).toContain('data-shortcut-mod');
    expect(mainSrc).toContain("applyEmptyStateShortcutHints(baseEmptyEl)");
    expect(mainSrc).toContain("applyEmptyStateShortcutHints(emptyEl)");
    expect(editorSrc).toContain("applyEmptyStateShortcutHints(emptyEl)");
  });
});

describe("clear modified confirm", () => {
  let createActivityPane: ActivityPane["createActivityPane"];
  let fake: { document: FakeDocument; cleanup: () => void };
  let clearModified: ReturnType<typeof vi.fn>;

  function paneElements(): {
    elements: Parameters<ActivityPane["createActivityPane"]>[0]["elements"];
    btnClearModified: FakeEl;
  } {
    const planPanel = fake.document.createElement("section");
    const planHeader = fake.document.createElement("div");
    planHeader.className = "panel-header";
    planPanel.appendChild(planHeader);
    const modifiedPanel = fake.document.createElement("div");
    const modifiedHeader = fake.document.createElement("div");
    modifiedHeader.className = "panel-header";
    modifiedPanel.appendChild(modifiedHeader);
    const btnClearModified = fake.document.createElement("button");
    const btnAcceptAll = fake.document.createElement("button");
    const btnDispatch = fake.document.createElement("button");
    return {
      btnClearModified,
      elements: {
        planPanel: planPanel as unknown as HTMLElement,
        planList: fake.document.createElement("ul") as unknown as HTMLElement,
        planCount: fake.document.createElement("span") as unknown as HTMLElement,
        btnDispatch: btnDispatch as unknown as HTMLButtonElement,
        modifiedList: fake.document.createElement("ul") as unknown as HTMLElement,
        modifiedPanel: modifiedPanel as unknown as HTMLElement,
        modifiedCount: fake.document.createElement("span") as unknown as HTMLElement,
        btnClearModified: btnClearModified as unknown as HTMLButtonElement,
        btnAcceptAll: btnAcceptAll as unknown as HTMLButtonElement,
      },
    };
  }

  beforeAll(async () => {
    fake = installFakeDom();
    clearModified = vi.fn().mockResolvedValue({ ok: true });
    (globalThis as unknown as { window: unknown }).window = {
      termina: {
        clearModified,
        onPlanUpdate: () => () => {},
        onModifiedList: () => () => {},
      },
    };
    ({ createActivityPane } = await import("../../../src/main/activity-pane.ts"));
  });

  beforeEach(() => {
    showConfirm.mockReset();
    clearModified.mockClear();
    clearModified.mockResolvedValue({ ok: true });
  });

  afterAll(() => {
    fake.cleanup();
  });

  function mount(): FakeEl {
    const { elements, btnClearModified } = paneElements();
    createActivityPane({
      elements,
      getActivePane: () => ({
        instanceId: "term-1",
        projectId: "p1",
        workspaceId: "w1",
        modified: [{ path: "/tmp/a.ts", relPath: "a.ts", status: "modified" }],
        accepted: new Map(),
        reverted: new Set(),
        plan: [],
        planLoaded: true,
        planLoadAttempts: 0,
        planVersion: 1,
      }),
      getActivePaneId: () => "term-1",
      getPaneById: () => undefined,
      getAllPanes: () => [],
      onPlanContent: () => {},
      onModifiedContent: () => {},
      onReviewChanged: () => {},
      onModifiedListChanged: () => {},
      onShowWorker: () => {},
      openReview: () => {},
    });
    return btnClearModified;
  }

  it("does not clear when the confirm is cancelled", async () => {
    showConfirm.mockResolvedValue({ cancelled: true });
    mount().click();
    await Promise.resolve();
    await Promise.resolve();
    expect(showConfirm).toHaveBeenCalledWith(
      "Clear review list?",
      "Your files remain changed on disk, but Termina will stop tracking them in this run.",
    );
    expect(clearModified).not.toHaveBeenCalled();
  });

  it("does not clear when the confirm is dismissed without confirmed", async () => {
    showConfirm.mockResolvedValue({});
    mount().click();
    await Promise.resolve();
    await Promise.resolve();
    expect(clearModified).not.toHaveBeenCalled();
  });

  it("clears only after an explicit confirm", async () => {
    showConfirm.mockResolvedValue({ confirmed: true });
    mount().click();
    await Promise.resolve();
    await Promise.resolve();
    expect(clearModified).toHaveBeenCalledWith("term-1");
  });

  it("asks before calling clearModified", () => {
    expect(activitySrc).toContain("showConfirm(");
    expect(activitySrc.indexOf("showConfirm(")).toBeLessThan(activitySrc.indexOf("clearModified("));
  });
});

describe("settings chrome", () => {
  it("adds a statusbar Settings control wired to the existing settings view", () => {
    expect(html).toMatch(/id="btn-settings"[^>]*aria-label="Settings"/);
    expect(html).toContain("btn-settings");
    expect(html.indexOf("btn-settings")).toBeLessThan(html.indexOf("btn-app-update"));
    expect(mainSrc).toContain('getElementById("btn-settings")');
    expect(mainSrc).toContain("btnSettings.addEventListener(\"click\", () => settingsView.open(committedPreferences))");
    expect(mainSrc).toContain('commands.register("open-settings", () => settingsView.open(committedPreferences))');
  });
});

describe("status activity copy (issue #348)", () => {
  it("presents blocked activity through one mapper and never interpolates protocol reasons", () => {
    const presentStart = mainSrc.indexOf("function presentActivity(");
    const presentEnd = mainSrc.indexOf("function renderStatus(");
    expect(presentStart).toBeGreaterThan(-1);
    expect(presentEnd).toBeGreaterThan(presentStart);
    const presentSrc = mainSrc.slice(presentStart, presentEnd);
    expect(presentSrc).toContain("blockedLabel: presentBlockedLabel(pane.activity?.reason)");
    expect(presentSrc).not.toContain("`blocked: ${reason}`");
    expect(presentSrc).not.toContain("lease-wait");
    expect(presentSrc).not.toContain("sidecar-paused");
    expect(presentSrc).not.toContain("writerId");
    expect(mainSrc).toContain('statusState.textContent = presented.blocked');
    expect(mainSrc).toContain("pane.statusEl.title = presented.blocked ? presented.blockedLabel");
  });
});
