import { describe, expect, it, vi } from "vitest";
import { callDiscoveredMcpTool, mcpClientTools, searchMcpTools, selectMcpTools } from "../../../agent-core/mcp.ts";
import { toolInputError } from "../../../agent-core/tool-dispatch.ts";
import { done } from "../../../agent-core/main/tools.ts";
import { SCHEMA_CAP } from "../../../agent-core/mcp/config.ts";

function catalog(count = 6) {
  return selectMcpTools(Array.from({ length: count }, (_, i) => ({
    name: `tool_${i}`, original: `tool_${i}`, server: "assets",
    description: i === 4 ? "Download a Blender texture" : `operation ${i}`,
    input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  })));
}

describe("deferred MCP definitions", () => {
  it("exposes only a constant discovery/call surface regardless of catalog size", () => {
    expect(mcpClientTools([], [])).toEqual([]);
    const before = JSON.stringify(mcpClientTools([], catalog(1)));
    expect(JSON.stringify(mcpClientTools([], catalog(32)))).toBe(before);
    expect(before).not.toContain("Download a Blender texture");
    searchMcpTools(catalog(), { query: "texture" });
    expect(JSON.stringify(mcpClientTools([], catalog()))).toBe(before);
    const defs = mcpClientTools([], catalog());
    defs[0]!.description = "mutated";
    expect(JSON.stringify(mcpClientTools([], catalog()))).toBe(before);
  });

  it("returns full schemas on demand, with exact names ranked ahead of keywords", () => {
    const tools = catalog();
    const found = JSON.parse(searchMcpTools(tools, { query: "blender texture" }));
    expect(found.total).toBe(1);
    expect(found.tools[0].name).toBe("mcp_assets_tool_4");
    expect(found.tools[0].input_schema).toEqual(tools[4]!.input_schema);
    expect(JSON.parse(searchMcpTools(tools, { query: "mcp_assets_tool_4" })).tools[0].name).toBe(tools[4]!.name);
    expect(JSON.parse(searchMcpTools(tools, { query: "absent" }))).toEqual({ tools: [], total: 0, next_offset: null });
  });

  it("allows deterministic browsing of every selected tool without prefix mutations", () => {
    const tools = catalog();
    const names: string[] = [];
    let offset: number | null = 0;
    do {
      const page = JSON.parse(searchMcpTools(tools, { query: "", offset }));
      expect(page.tools.length).toBeLessThanOrEqual(2);
      names.push(...page.tools.map((t: { name: string }) => t.name));
      offset = page.next_offset;
    } while (offset !== null);
    expect(names).toEqual(tools.map((t) => t.name));
    expect(JSON.parse(searchMcpTools(tools, { query: "", offset: 100 })).tools).toEqual([]);
  });

  it("keeps large Unicode schemas complete through the model-visible result budget", () => {
    const tools = selectMcpTools(Array.from({ length: 4 }, (_, i) => ({
      name: `large_${i}`, original: `large_${i}`, server: "large",
      description: "界".repeat(1024),
      input_schema: { type: "object", description: "x".repeat(SCHEMA_CAP - 100) },
    })));
    const text = searchMcpTools(tools, { query: "" });
    const result = done({ id: "search", name: "search_mcp_tools", input: { query: "" } }, text);
    expect(result.bounded?.truncated).toBe(false);
    const page = JSON.parse(String(result.result.content));
    expect(page.tools).toHaveLength(1);
    expect(page.tools[0].input_schema).toEqual(tools[0]!.input_schema);
    expect(page.next_offset).toBe(1);
  });

  it("rejects invalid queries and call envelopes before contacting a server", async () => {
    for (const input of [{}, { query: 5 }, { query: "x".repeat(1025) }, { query: "", offset: -1 }, { query: "", offset: 0.5 }]) {
      expect(searchMcpTools(catalog(), input)).toMatch(/^error:/);
    }
    const definitions = mcpClientTools([], catalog());
    for (const input of [{ name: "x" }, { name: "x", arguments: [] }, { name: 5, arguments: {} }]) {
      expect(toolInputError({ name: "call_mcp_tool", input }, definitions)).toContain("invalid tool arguments");
    }
    const call = vi.fn();
    await expect(callDiscoveredMcpTool({ tools: [], notes: [], call, shutdown() {} }, { name: "x", arguments: [] })).rejects.toThrow("arguments object");
    expect(call).not.toHaveBeenCalled();
  });

  it("delegates exact arguments and cancellation to the canonical session", async () => {
    const outcome = { content: "result", isError: false };
    const call = vi.fn().mockResolvedValue(outcome);
    const options = { shouldStop: () => true, timeoutMs: 10 };
    const result = await callDiscoveredMcpTool({ tools: catalog(), notes: [], call, shutdown() {} }, {
      name: "mcp_assets_tool_4", arguments: { value: "texture" },
    }, options);
    expect(call).toHaveBeenCalledExactlyOnceWith("mcp_assets_tool_4", { value: "texture" }, options);
    expect(result).toBe(outcome);
  });
});
