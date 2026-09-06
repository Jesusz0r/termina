import { describe, expect, it } from "vitest";
import { protocolEndpoint, providerProtocol, providerProtocolHeaders, requestHeaders } from "../../../agent-core/auth.ts";

describe("provider and protocol composition", () => {
  it("uses the same Messages path for native Claude and catalog-selected Copilot Claude", () => {
    const native = providerProtocol("anthropic", "claude-opus-4-6");
    const copilot = providerProtocol("github-copilot", "claude-opus-4-6", ["/v1/messages"]);
    expect(copilot).toBe(native);
    expect(protocolEndpoint("https://api.anthropic.com", "claude-opus-4-6", native)).toBe("https://api.anthropic.com/v1/messages");
    expect(protocolEndpoint("https://api.individual.githubcopilot.com", "claude-opus-4-6", copilot)).toBe("https://api.individual.githubcopilot.com/v1/messages");
    const headers = requestHeaders("github-copilot", "test-token");
    expect(providerProtocolHeaders("github-copilot", headers, copilot)["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-version"]).toBeUndefined();
  });

  it("keeps provider-specific MiniMax routing through shared URL serialization", () => {
    expect(protocolEndpoint("https://opencode.ai/zen/go/v1", "minimax-m3", providerProtocol("opencode-go", "minimax-m3"))).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(protocolEndpoint("https://opencode.ai/zen/v1", "minimax-m3", providerProtocol("opencode-zen", "minimax-m3"))).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("converts Zen native Gemini authentication without mutating stored headers", () => {
    const headers = requestHeaders("opencode-zen", "test-token");
    const native = providerProtocolHeaders("opencode-zen", headers, "google-generate");
    expect(native["x-goog-api-key"]).toBe("test-token");
    expect(native.authorization).toBeUndefined();
    expect(native["x-api-key"]).toBeUndefined();
    expect(headers.authorization).toBe("Bearer test-token");
    expect(protocolEndpoint("https://opencode.ai/zen/v1/", "google/gemini-3.7-flash", "google-generate", false)).toBe("https://opencode.ai/zen/v1/models/gemini-3.7-flash:generateContent");
  });
});
