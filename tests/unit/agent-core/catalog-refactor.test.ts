import { describe, expect, it } from "vitest";
import { MODEL_LIST_CAP, parseModelsPayload } from "../../../agent-core/models.ts";
import { catalogOutputLimit, catalogReasoningLevels, catalogSupportsTools } from "../../../agent-core/models/capabilities.ts";

describe("catalog provider policy composition", () => {
  it("keeps Copilot metadata scoped to Copilot and preserves top-level context precedence", () => {
    const row = {
      id: "claude-opus-4-6", context_length: 96000,
      capabilities: { limits: { max_context_window_tokens: 128000, max_prompt_tokens: 120000 } },
      supported_endpoints: ["/v1/messages", "/unknown", "/responses", "/responses"],
    };
    expect(parseModelsPayload([row], "github-copilot")).toEqual([
      { id: row.id, context: 96000, supportedEndpoints: ["/responses", "/v1/messages"] },
    ]);
    expect(parseModelsPayload([row], "anthropic")).toEqual([{ id: row.id, context: 96000 }]);
  });

  it("keeps empty advertised endpoints distinct from absent metadata", () => {
    expect(parseModelsPayload([
      { id: "gpt-empty", supported_endpoints: ["/unknown"] },
      { id: "gpt-absent", capabilities: [] },
      { id: "gpt-prompt", capabilities: { limits: { max_prompt_tokens: 32000 } } },
    ], "github-copilot")).toEqual([
      { id: "gpt-empty", supportedEndpoints: [] }, { id: "gpt-absent" },
      { id: "gpt-prompt", context: 32000 },
    ]);
  });

  it("retains doc-confirmed OpenRouter and Codex capability metadata", () => {
    const openrouter = {
      id: "deepseek/deepseek-r1",
      name: "DeepSeek R1",
      context_length: 128000,
      top_provider: { context_length: 128000, max_completion_tokens: 64000, is_moderated: false },
      supported_parameters: ["tools", "temperature", "reasoning"],
    };
    expect(parseModelsPayload([openrouter], "openrouter")).toEqual([
      {
        id: "deepseek/deepseek-r1",
        name: "DeepSeek R1",
        context: 128000,
        outputLimit: 64000,
        supportedParameters: ["tools", "temperature", "reasoning"],
      },
    ]);
    const codex = {
      id: "gpt-5.6",
      supported_reasoning_levels: [
        { effort: "low", description: "fast" },
        { effort: "  MEDIUM ", description: "balanced" },
        { effort: 42, description: "junk" },
      ],
    };
    expect(parseModelsPayload([codex], "openai-codex")).toEqual([
      { id: "gpt-5.6", reasoningLevels: ["low", "medium"] },
    ]);
  });

  it("resolves catalog metadata with silence distinct from zero", () => {
    expect(catalogOutputLimit(undefined)).toBeNull();
    expect(catalogOutputLimit({ id: "m" })).toBeNull();
    expect(catalogOutputLimit({ id: "m", outputLimit: 64000 })).toBe(64000);
    expect(catalogReasoningLevels(undefined)).toBeNull();
    expect(catalogReasoningLevels({ id: "m", reasoningLevels: ["low", "medium"] })).toEqual(["low", "medium"]);
    expect(catalogSupportsTools(undefined)).toBeNull();
    expect(catalogSupportsTools({ id: "m" })).toBeNull();
    expect(catalogSupportsTools({ id: "m", supportedParameters: ["tools", "temperature"] })).toBe(true);
    expect(catalogSupportsTools({ id: "m", supportedParameters: ["temperature"] })).toBe(false);
  });

  it("applies generic filtering, duplicate handling and caps with permissive provider policies", () => {
    const rows = [null, [], { id: "text-embedding-3-small" }, { id: "big-pickle" },
      { id: "big-pickle" }, { id: "x".repeat(201) },
      ...Array.from({ length: MODEL_LIST_CAP + 5 }, (_, i) => ({ id: `custom-${i}` })),
    ];
    const models = parseModelsPayload({ data: rows }, "opencode-go");
    expect(models).toHaveLength(MODEL_LIST_CAP);
    expect(models[0]).toEqual({ id: "big-pickle" });
    expect(models.at(-1)).toEqual({ id: `custom-${MODEL_LIST_CAP - 2}` });
  });
});
