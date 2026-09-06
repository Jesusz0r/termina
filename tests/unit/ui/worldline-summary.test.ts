import { describe, expect, it } from "vitest";
import { worldlineHeaderSummary } from "../../../src/worldline-evidence.ts";

describe("worldline header summary", () => {
  it("states both candidates", () => {
    expect(worldlineHeaderSummary("cmp-3", "ready", "running", null)).toBe("cmp-3 · A ready · B running");
  });

  it("appends the evidence caption when ranked", () => {
    expect(worldlineHeaderSummary("cmp-3", "ready", "ready", "deps → A")).toBe(
      "cmp-3 · A ready · B ready · deps → A",
    );
  });
});
