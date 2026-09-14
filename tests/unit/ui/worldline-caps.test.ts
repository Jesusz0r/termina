import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldlineChangedFile, WorldlineDetails, WorldlineSummary } from "../../../shared/types";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

type Worldlines = typeof import("../../../src/worldlines.ts");
type Modals = typeof import("../../../src/components/modals.ts");

let worldlines: Worldlines;
let modals: Modals;
let fake: { document: FakeDocument; modalRoot: FakeEl; cleanup: () => void };
let pendingDetails: WorldlineDetails | null = null;

function summary(label: "A" | "B"): WorldlineSummary {
  return {
    id: `cmp-1-${label.toLowerCase()}`,
    comparisonId: "cmp-1",
    label,
    role: label === "A" ? "reference" : "alternative",
    comparisonBaseStateId: "base",
    promotionBaseStateId: "base",
    headStateId: "head",
    sourceRunId: "run-1",
    terminalId: null,
    version: 1,
    state: "ready",
    error: null,
    root: `/r/${label.toLowerCase()}`,
    sessionFile: "session.jsonl",
    model: "test-model",
    thinkingLevel: null,
    createdAt: Date.now(),
  };
}

function details(label: "A" | "B", fileCount: number): WorldlineDetails {
  const changedFiles: WorldlineChangedFile[] = [];
  for (let i = 0; i < fileCount; i++) changedFiles.push({ relPath: `file-${i}.ts`, status: "modified" });
  return {
    id: `cmp-1-${label.toLowerCase()}`,
    comparisonId: "cmp-1",
    label,
    state: "ready",
    error: null,
    sourceRunId: "run-1",
    comparisonBaseStateId: "base",
    promotionBaseStateId: "base",
    headStateId: "head",
    model: "test-model",
    thinkingLevel: null,
    createdAt: Date.now(),
    sourceFiles: fileCount,
    sourceBytes: 1024,
    changedFiles,
    dependencies: [],
    ageMs: 1000,
    unownedEdits: 0,
    ignoredFiles: 0,
    ignoredBytes: 0,
    primaryConflicts: [],
  };
}

function makePanel(): FakeEl {
  const panel = fake.document.createElement("div");
  for (const id of ["worldline-list", "worldline-count", "worldline-summary"]) {
    const el = fake.document.createElement("div");
    el.id = id;
    panel.appendChild(el);
  }
  const header = fake.document.createElement("div");
  header.className = "panel-header";
  panel.appendChild(header);
  return panel;
}

beforeAll(async () => {
  fake = installFakeDom();
  (globalThis as Record<string, unknown>).window = {
    termina: {
      getWorldlineDetails: async () => {
        const d = pendingDetails;
        return d ? { ok: true, details: d } : { ok: false, error: "no fixture details" };
      },
    },
  };
  worldlines = await import("../../../src/worldlines.ts");
  modals = await import("../../../src/components/modals.ts");
});

beforeEach(() => {
  fake.modalRoot.replaceChildren();
  pendingDetails = null;
});

afterAll(() => {
  fake.cleanup();
  delete (globalThis as Record<string, unknown>).window;
});

describe("worldline changed-file caps (refs #213)", () => {
  it("caps the inline details list with an overflow note and honest totals", async () => {
    const panel = makePanel();
    const view = new worldlines.WorldlinesView(panel as unknown as HTMLElement);
    view.bind({});
    view.upsert(summary("A"));
    view.upsert(summary("B"));

    pendingDetails = details("A", 10_000);
    // Each card carries two .cand-details toggles (details ▾, overflow ⋯); the first is details.
    panel.querySelectorAll(".candidate-card")[0].querySelectorAll(".cand-details")[0].click();
    const changedList = panel.querySelectorAll(".cand-changed")[0];
    await vi.waitFor(() => {
      expect(changedList.children.length).toBeGreaterThan(1);
    });

    expect(changedList.children.length).toBe(worldlines.MAX_INLINE_CHANGED_ROWS + 1);
    const note = changedList.children.at(-1)!;
    expect(note.className).toBe("cand-more");
    expect(note.textContent).toContain("9500 more");
    expect(note.textContent).toContain("Compare");
    // Totals stay honest: the array itself is complete on the renderer side.
    const card = panel.querySelectorAll(".candidate-card")[0];
    expect(card.querySelector(".cand-changed-title")!.textContent).toBe("Changed vs base (10000)");
    expect(card.querySelector(".cand-stats")!.textContent).toContain("10000 changed");
  });

  it("renders small inline lists fully with no overflow note", async () => {
    const panel = makePanel();
    const view = new worldlines.WorldlinesView(panel as unknown as HTMLElement);
    view.bind({});
    view.upsert(summary("A"));
    view.upsert(summary("B"));

    pendingDetails = details("A", 3);
    panel.querySelectorAll(".candidate-card")[0].querySelectorAll(".cand-details")[0].click();
    const changedList = panel.querySelectorAll(".cand-changed")[0];
    await vi.waitFor(() => {
      expect(changedList.children.length).toBe(3);
    });
    expect(changedList.querySelectorAll(".cand-more")).toHaveLength(0);
  });

  it("caps the Compare file-list modal with an overflow note", () => {
    const items: Array<[string, "modified"]> = [];
    for (let i = 0; i < 10_000; i++) items.push([`file-${i}.ts`, "modified"]);
    modals.showFileListModal("A ⇄ B — 10000 file(s)", items, () => {});
    const list = fake.modalRoot.querySelector(".worldline-list")!;
    expect(list.children.length).toBe(modals.MAX_FILE_LIST_MODAL_ROWS + 1);
    const note = list.children.at(-1)!;
    expect(note.className).toBe("worldline-more");
    expect(note.textContent).toContain("9000 more");
    expect(fake.modalRoot.querySelector(".modal-title")!.textContent).toBe("A ⇄ B — 10000 file(s)");
  });

  it("renders small file-list modals fully with no overflow note", () => {
    modals.showFileListModal("base → A — 2 file(s)", [["a.ts", "modified"], ["b.ts", "created"]], () => {});
    const list = fake.modalRoot.querySelector(".worldline-list")!;
    expect(list.children.length).toBe(2);
    expect(list.querySelectorAll(".worldline-more")).toHaveLength(0);
  });
});
