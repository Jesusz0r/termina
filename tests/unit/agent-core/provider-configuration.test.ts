import { describe, expect, it } from "vitest";
import { providerProtocol, requestHeaders } from "../../../agent-core/auth.ts";
import { parseModelsPayload } from "../../../agent-core/models.ts";
import { responsesBody } from "../../../agent-core/openai-compat.ts";

describe("provider configuration audit regressions", () => {
  it("does not request tool selection for a tool-free xAI summary", () => {
    const body = responsesBody("grok-4.6", "Summarize", [{ role: "user", content: "OK" }], [], {
      provider: "xai", includeEncryptedReasoning: false,
    });
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("keeps automatic selection when tools exist", () => {
    const body = responsesBody("grok-4.6", "sys", [], [{ name: "read_file", description: "Read", input_schema: { type: "object", properties: {} } }]);
    expect(body.tool_choice).toBe("auto");
  });

  it("excludes xAI video generators from coding models", () => {
    expect(parseModelsPayload({ data: [
      { id: "grok-4.6" }, { id: "grok-imagine-video" }, { id: "grok-imagine-video-1.5" },
    ] }, "xai").map((model) => model.id)).toEqual(["grok-4.6"]);
  });

  it("respects Codex picker visibility without hiding ChatGPT-only models", () => {
    expect(parseModelsPayload({ models: [
      { slug: "gpt-6-astra", visibility: "list", context_window: 272000 },
      { slug: "codex-auto-review", visibility: "hide" },
      { slug: "gpt-reserve", visibility: "hide" },
      { slug: "gpt-5.3-codex-spark", visibility: "list", supported_in_api: false },
    ] }, "openai-codex").map((model) => model.id)).toEqual(["gpt-6-astra", "gpt-5.3-codex-spark"]);
  });

  it.each([
    ["anthropic", "claude-sonnet-5", "anthropic-messages"],
    ["openai", "gpt-5.6-sol", "openai-responses"],
    ["openai-codex", "gpt-5.6-sol", "openai-codex-responses"],
    ["google", "gemini-3.7-flash", "openai-completions"],
    ["xai", "grok-4.6", "openai-responses"],
    ["openrouter", "anthropic/claude-sonnet-5", "openai-responses"],
  ] as const)("routes %s default family correctly", (provider, model, protocol) => {
    expect(providerProtocol(provider, model)).toBe(protocol);
  });

  it("keeps OpenRouter stateless and Google bearer authentication", () => {
    expect(responsesBody("openai/gpt-5.6-sol", "sys", [], [], { provider: "openrouter" }).store).toBe(false);
    expect(requestHeaders("google", "fixture-key").authorization).toBe("Bearer fixture-key");
    expect(requestHeaders("anthropic", "fixture-key")["anthropic-version"]).toBe("2023-06-01");
  });

  it.each([
    ["gpt-5.6-terra", ["/responses"], "openai-responses"],
    ["claude-sonnet-5", ["/chat/completions"], "openai-completions"],
    ["gemini-3.7-flash", ["/chat/completions"], "openai-completions"],
    ["claude-sonnet-5", ["/v1/messages"], "anthropic-messages"],
    ["gpt-4.1", ["/chat/completions", "/responses"], "openai-responses"],
  ] as const)("uses Copilot catalog endpoints for %s", (id, endpoints, expected) => {
    const [model] = parseModelsPayload({ data: [{ id, supported_endpoints: endpoints,
      capabilities: { type: "chat", limits: { max_context_window_tokens: 128000, max_prompt_tokens: 120000 } },
    }] }, "github-copilot");
    expect(model?.context).toBe(128000);
    expect(providerProtocol("github-copilot", id, model?.supportedEndpoints)).toBe(expected);
  });

  it("defaults Copilot to Chat Completions when endpoint metadata is absent", () => {
    expect(providerProtocol("github-copilot", "claude-sonnet-5")).toBe("openai-completions");
  });
});
