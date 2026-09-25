import { describe, expect, it } from "vitest";
import { insertionIndex, reorderPermutation } from "../../../shared/tab-order.ts";

describe("tab order", () => {
  it("accepts a permutation and rejects a different set", () => {
    expect(reorderPermutation(["a", "b", "c"], ["c", "a", "b"])).toEqual(["c", "a", "b"]);
    expect(reorderPermutation(["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
    expect(reorderPermutation(["a", "b"], ["b"])).toBeNull();
    expect(reorderPermutation(["a", "b"], ["b", "a", "a"])).toBeNull();
    expect(reorderPermutation(["a", "b"], ["b", "c"])).toBeNull();
  });

  it("lands before the tab whose midpoint the pointer has not passed", () => {
    const slots = [
      { left: 0, width: 100 },
      { left: 104, width: 100 },
      { left: 208, width: 100 },
    ];
    expect(insertionIndex(40, slots)).toBe(0);
    expect(insertionIndex(60, slots)).toBe(1);
    expect(insertionIndex(160, slots)).toBe(2);
    expect(insertionIndex(400, slots)).toBe(3);
  });
});
