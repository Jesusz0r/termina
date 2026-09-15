import { describe, expect, it } from "vitest";
import { MODELS_DISPLAY_CAP, MODEL_LIST_CAP, catalogHeaders, filterCatalogModels, formatCatalogLines, isChatModel, parseModelsPayload, type CatalogModel } from "../../../agent-core/models.ts";
import { catalogOutputLimit, catalogSupportsTools } from "../../../agent-core/models/capabilities.ts";

describe("catalogHeaders denylist", () => {
  it("copies auth headers and drops POST-only fields", () => {
    const headers = catalogHeaders({
      authorization: "Bearer x",
      "content-type": "application/json",
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
      "x-new-provider": "keep-me",
    });
    expect(headers).toEqual({
      accept: "application/json",
      authorization: "Bearer x",
      originator: "codex_cli_rs",
      "x-new-provider": "keep-me",
    });
  });
});

describe("catalog provider policy composition", () => {
  it("keeps the official OpenAI catalog on OpenAI ids", () => {
    expect(parseModelsPayload({ data: [
      { id: "gpt-5.6-sol" },
      { id: "o3-mini" },
      { id: "chatgpt-4o-latest" },
      { id: "claude-sonnet-5" },
      { id: "grok-4.6" },
      { id: "gemini-3.7-flash" },
      { id: "gemma-3-27b-it" },
      { id: "deepseek-v4-pro" },
    ] }, "openai").map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "o3-mini",
      "chatgpt-4o-latest",
    ]);
    expect(isChatModel("gpt-4o", "openai")).toBe(true);
    expect(isChatModel("claude-sonnet-5", "openai")).toBe(false);
    expect(isChatModel("grok-4.6", "openai")).toBe(false);
  });

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

  it("filters the catalog by query and marks truncated lists explicitly", () => {
    const rows = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "xai", id: "grok-4.6" },
    ] as const;
    expect(filterCatalogModels([...rows], "grok").map((m) => m.id)).toEqual(["grok-4.6"]);
    expect(filterCatalogModels([...rows], "ANTHROPIC/claude").map((m) => m.id)).toEqual(["claude-sonnet-4-5"]);
    expect(filterCatalogModels([...rows], "GPT").map((m) => m.id)).toEqual(["gpt-4o"]);
    expect(filterCatalogModels([...rows], "  ")).toHaveLength(3);
    expect(filterCatalogModels([...rows], "zzz")).toHaveLength(0);
    expect(MODELS_DISPLAY_CAP).toBe(MODEL_LIST_CAP);
    const many = Array.from({ length: MODELS_DISPLAY_CAP + 5 }, (_, i) => ({ provider: "p", id: `m-${i}` }));
    const text = formatCatalogLines(many as CatalogModel[], "p", "m-0");
    expect(text.split("\n")).toHaveLength(MODELS_DISPLAY_CAP + 1);
    expect(text).toMatch(/\(\+5 more/);
    expect(formatCatalogLines([...rows], "xai", "grok-4.6")).not.toMatch(/more/);
  });

  it("fuzzy-matches model abbreviations and unordered words across catalog fields", () => {
    const rows: CatalogModel[] = [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "openai", id: "gpt-4o", name: "Flagship Omni" },
      { provider: "xai", id: "sonnet45" },
    ];
    expect(filterCatalogModels(rows, " SONNET45 ")).toEqual([rows[2], rows[0]]);
    expect(filterCatalogModels(rows, "son45 ANTH")).toEqual([rows[0]]);
    expect(filterCatalogModels(rows, "flgom")).toEqual([rows[1]]);
    expect(filterCatalogModels(rows, "sonnet missing")).toEqual([]);
    expect(filterCatalogModels(rows, "54tennos")).toEqual([]);
    expect(filterCatalogModels(rows, "  \t ")).toBe(rows);
    expect(rows.map((m) => m.provider)).toEqual(["anthropic", "openai", "xai"]);
  });

  it("resolves catalog metadata with silence distinct from zero", () => {
    expect(catalogOutputLimit(undefined)).toBeNull();
    expect(catalogOutputLimit({ id: "m" })).toBeNull();
    expect(catalogOutputLimit({ id: "m", outputLimit: 64000 })).toBe(64000);
    expect(catalogSupportsTools(undefined)).toBeNull();
    expect(catalogSupportsTools({ id: "m" })).toBeNull();
    expect(catalogSupportsTools({ id: "m", supportedParameters: ["tools", "temperature"] })).toBe(true);
    expect(catalogSupportsTools({ id: "m", supportedParameters: ["temperature"] })).toBe(false);
  });

  it("keeps documented small context windows and rejects garbage", () => {
    expect(parseModelsPayload([{ id: "qwen-tiny", context_length: 4096 }], "opencode-go")).toEqual([
      { id: "qwen-tiny", context: 4096 },
    ]);
    expect(parseModelsPayload([{ id: "qwen-zero", context_length: 0 }], "opencode-go")).toEqual([
      { id: "qwen-zero" },
    ]);
    expect(parseModelsPayload([{ id: "qwen-nan", context_length: Number.NaN }], "opencode-go")).toEqual([
      { id: "qwen-nan" },
    ]);
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
