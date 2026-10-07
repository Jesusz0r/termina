import { describe, expect, it } from "vitest";
import { insertionIndex, orderByStrip, reorderPermutation } from "../../../shared/tab-order.ts";

describe("tab order", () => {
  it("accepts a permutation and rejects a different set", () => {
    expect(reorderPermutation(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
    expect(reorderPermutation(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
    expect(reorderPermutation(["a", "b"], ["b"])).toBeNull();
    expect(reorderPermutation(["a", "b"], ["b", "a", "a"])).toBeNull();
    expect(reorderPermutation(["a", "b"], ["b", "c"])).toBeNull();
  });

  it("publishes terminals in project-strip order, then terminal-strip order", () => {
    const live = [
      { id: "term-1", projectId: "p1" },
      { id: "term-2", projectId: "p1" },
      { id: "term-3", projectId: "p2" },
      { id: "term-4", projectId: null },
    ];
    const projects = [
      { id: "p2", terminalIds: ["term-3"] },
      { id: "p1", terminalIds: ["term-2", "term-1"] },
    ];
    expect(orderByStrip(live, projects).map((terminal) => terminal.id)).toEqual([
      "term-3",
      "term-2",
      "term-1",
      "term-4",
    ]);
  });

  it("keeps creation order for terminals the strips do not rank", () => {
    const live = [
      { id: "term-9", projectId: "p1" },
      { id: "term-8", projectId: "p1" },
    ];
    expect(orderByStrip(live, [{ id: "p1", terminalIds: [] }]).map((terminal) => terminal.id)).toEqual([
      "term-9",
      "term-8",
    ]);
  });

  it("lands before the tab whose midpoint the pointer has not passed", () => {
    const slots = [
      { start: 0, size: 100 },
      { start: 104, size: 100 },
      { start: 208, size: 100 },
    ];
    expect(insertionIndex(40, slots)).toBe(0);
    expect(insertionIndex(60, slots)).toBe(1);
    expect(insertionIndex(160, slots)).toBe(2);
    expect(insertionIndex(400, slots)).toBe(3);
  });

  it("uses axis-neutral positions, unequal sizes and exact midpoint boundaries", () => {
    const slots = [
      { start: 200, size: 40 },
      { start: 244, size: 80 },
      { start: 328, size: 24 },
    ];
    expect(insertionIndex(219, slots)).toBe(0);
    expect(insertionIndex(220, slots)).toBe(1);
    expect(insertionIndex(283, slots)).toBe(1);
    expect(insertionIndex(284, slots)).toBe(2);
    expect(insertionIndex(340, slots)).toBe(3);
    expect(insertionIndex(200, [])).toBe(0);
  });
});
