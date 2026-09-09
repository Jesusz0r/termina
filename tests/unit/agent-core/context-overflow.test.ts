import { describe, expect, it } from "vitest";

describe("Agent Core context-overflow detection", () => {
  it("matches the Gemini 500k prompt-length shape and known providers", async () => {
    const { isContextOverflowMessage } = await import("../../../agent-core/main.ts");
    expect(isContextOverflowMessage(
      `API 400: {"code":"invalid-argument","error":"This model's maximum prompt length is 500000 but the request contains 507124 tokens."}`,
    )).toBe(true);
    expect(isContextOverflowMessage("prompt is too long: 200000 tokens > 150000 maximum")).toBe(true);
    expect(isContextOverflowMessage("maximum context length exceeded")).toBe(true);
    expect(isContextOverflowMessage("context_length_exceeded")).toBe(true);
    expect(isContextOverflowMessage("request_too_large")).toBe(true);
    expect(isContextOverflowMessage("input tokens too long")).toBe(true);
  });

  it("rejects benign messages so overflow recovery cannot misfire", async () => {
    const { isContextOverflowMessage } = await import("../../../agent-core/main.ts");
    expect(isContextOverflowMessage("hello world")).toBe(false);
    expect(isContextOverflowMessage("context window info")).toBe(false);
    expect(isContextOverflowMessage("stream terminated before first token")).toBe(false);
    expect(isContextOverflowMessage("invalid tool input: missing required field")).toBe(false);
  });
});
