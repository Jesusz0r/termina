import { describe, expect, it } from "vitest";
import { mcpDiscoveryDeclared, planTurnRejectsTool, sessionOmitsTool } from "../../../agent-core/tool-eligibility.ts";

describe("tool eligibility", () => {
  it("keeps bash available when it only needs approval, and refuses it on a plan turn", () => {
    expect(sessionOmitsTool("bash", { worldlineCandidate: false, subagentToolsVisible: true })).toBe(false);
    expect(planTurnRejectsTool("bash")).toBe(true);
    expect(planTurnRejectsTool("read_file")).toBe(false);
    expect(planTurnRejectsTool("search_mcp_tools")).toBe(true);
  });

  it("omits spawn_subagent for a worldline candidate and both subagent tools at the depth cap", () => {
    const visible = { worldlineCandidate: true, subagentToolsVisible: true };
    expect(sessionOmitsTool("spawn_subagent", visible)).toBe(true);
    expect(sessionOmitsTool("message_subagent", visible)).toBe(false);
    const capped = { worldlineCandidate: false, subagentToolsVisible: false };
    expect(sessionOmitsTool("spawn_subagent", capped)).toBe(true);
    expect(sessionOmitsTool("message_subagent", capped)).toBe(true);
    expect(sessionOmitsTool("read_file", capped)).toBe(false);
  });

  it("declares MCP discovery adapters only when a catalog exists", () => {
    expect(mcpDiscoveryDeclared(0)).toBe(false);
    expect(mcpDiscoveryDeclared(2)).toBe(true);
  });
});
