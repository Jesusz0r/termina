import { describe, expect, it } from "vitest";
import { toolExecutionWaves, toolInputError } from "../../../agent-core/tool-dispatch.ts";
import { SUBAGENT_TOOL_DEFS } from "../../../agent-core/subagents.ts";

const call = (name: string, input: unknown = {}) => ({ name, input });

describe("tool batch admission and ordering", () => {
  it("validates required fields, exact types and nested arguments from the canonical schemas", () => {
    expect(toolInputError(call("spawn_subagent", {}), SUBAGENT_TOOL_DEFS)).toContain("task is required");
    expect(toolInputError(call("spawn_subagent", { task: 12 }), SUBAGENT_TOOL_DEFS)).toContain("task must be string");
    expect(toolInputError(call("spawn_subagent", { task: "review", paths: ["ok", false] }), SUBAGENT_TOOL_DEFS)).toContain("paths[1]");
    expect(toolInputError(call("spawn_subagent", { task: "review", budget: { maxTurns: "2" } }), SUBAGENT_TOOL_DEFS)).toContain("maxTurns");
    expect(toolInputError(call("spawn_subagent", { task: "review", budget: { maxTurns: Infinity } }), SUBAGENT_TOOL_DEFS)).toContain("maxTurns");
    expect(toolInputError(call("spawn_subagent", { task: "review", budget: { turns: 2 } }), SUBAGENT_TOOL_DEFS)).toContain("not a supported argument");
    expect(toolInputError(call("spawn_subagent", { task: "review", budget: { maxTurns: 2 }, paths: [] }), SUBAGENT_TOOL_DEFS)).toBeNull();
    // Server-defined schemas are not reinterpreted by this built-in validator.
    expect(toolInputError(call("mcp_external", { anything: true }), SUBAGENT_TOOL_DEFS)).toBeNull();
  });

  it("batches only known reads, with a bound of four, and preserves every call's order", () => {
    const calls = Array.from({ length: 10 }, (_, i) => call("read_file", { path: `${i}` }));
    const waves = toolExecutionWaves(calls);
    expect(waves.map((wave) => wave.length)).toEqual([4, 4, 2]);
    expect(waves.flat().map((entry) => entry.index)).toEqual(calls.map((_, i) => i));
  });

  it("places bash, mutations, subagents and unknown MCP actions behind barriers", () => {
    for (const action of ["bash", "write_file", "edit", "spawn_subagent", "message_subagent", "mcp_anything"]) {
      const waves = toolExecutionWaves([call("read_file"), call("grep"), call(action), call("read_file"), call("glob")]);
      expect(waves.map((wave) => wave.map((entry) => entry.index))).toEqual([[0, 1], [2], [3, 4]]);
    }
  });

  it("coalesces exact read arguments regardless of key ordering but not across a state change", () => {
    const read = call("read_file", { path: "x", start_line: 1 });
    const reversed = call("read_file", { start_line: 1, path: "x" });
    const entries = toolExecutionWaves([read, reversed, call("bash"), reversed]).flat();
    expect(entries[1]).toEqual({ index: 1, duplicateOf: 0, reuseResult: true });
    expect(entries[3]).toEqual({ index: 3 });
    expect(toolExecutionWaves([read])[0]![0]).toEqual({ index: 0 });
  });

  it("does not deduplicate differing tails of large arrays or deeply nested input", () => {
    const a = Array.from({ length: 300 }, () => 0);
    const b = [...a]; b[299] = 1;
    expect(toolExecutionWaves([call("fetch", { a }), call("fetch", { a: b })]).flat()).toEqual([{ index: 0 }, { index: 1 }]);
    let deep: unknown = "x";
    for (let i = 0; i < 100; i++) deep = { deep };
    expect(toolExecutionWaves([call("fetch", deep), call("fetch", deep)]).flat()).toEqual([{ index: 0 }, { index: 1 }]);
  });

  it("refuses adjacent duplicate actions without suppressing later intentional re-runs", () => {
    const action = call("bash", { command: "printf x >> count" });
    const entries = toolExecutionWaves([action, action, action, call("read_file"), action]).flat();
    expect(entries.slice(1, 3)).toEqual([
      { index: 1, duplicateOf: 0, reuseResult: false },
      { index: 2, duplicateOf: 0, reuseResult: false },
    ]);
    expect(entries[4]).toEqual({ index: 4 });
  });
});
