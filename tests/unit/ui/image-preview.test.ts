import { describe, expect, it } from "vitest";
import { fitImageScale } from "../../../src/image-preview.ts";

describe("image fit scale", () => {
  it("fits landscape and portrait images within both viewport dimensions", () => {
    expect(fitImageScale(2400, 1200, 600, 400)).toBe(0.25);
    expect(fitImageScale(1200, 2400, 600, 400)).toBeCloseTo(1 / 6);
  });
  it("does not enlarge small images and handles a temporarily hidden pane", () => {
    expect(fitImageScale(100, 100, 600, 400)).toBe(1);
    expect(fitImageScale(100, 100, 0, 0)).toBe(0);
  });
});
