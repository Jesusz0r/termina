import { describe, expect, it } from "vitest";
import { MODEL_LIST_CAP, parseModelsPayload } from "../../../agent-core/models.ts";

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
