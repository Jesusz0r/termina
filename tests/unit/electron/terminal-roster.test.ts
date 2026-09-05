import { describe, expect, it } from "vitest";
import { isRosterModel, parseTerminalRoster } from "../../../electron/terminal-roster.ts";

describe("terminal roster model pin", () => {
  it("accepts a provider-qualified model on agent entries", () => {
    const [entry] = parseTerminalRoster([
      { id: "term-1", type: "agent", engine: "core", model: "anthropic/claude-opus-4-6" },
    ]);
    expect(entry?.model).toBe("anthropic/claude-opus-4-6");
  });

  it("drops malformed models but keeps the entry", () => {
    for (const model of ["", "no-slash", "/leading", "trailing/", "has space/x", "a\nb/x", "x".repeat(201)]) {
      const [entry] = parseTerminalRoster([{ id: "term-1", type: "agent", engine: "core", model }]);
      expect(entry?.model).toBeUndefined();
      expect(entry?.id).toBe("term-1");
    }
  });

  it("entries without a model stay valid", () => {
    const [entry] = parseTerminalRoster([{ id: "term-2", type: "agent", engine: "core" }]);
    expect(entry?.model).toBeUndefined();
  });

  it("validates the provider/model shape", () => {
    expect(isRosterModel("openai/gpt-5")).toBe(true);
    expect(isRosterModel("openrouter/openai/gpt-5")).toBe(true);
    expect(isRosterModel("bare")).toBe(false);
    expect(isRosterModel("a/")).toBe(false);
  });
});
