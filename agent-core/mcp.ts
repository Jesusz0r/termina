/**
 * Kernel-sized MCP client (stdio or HTTP).
 *
 * The user config lists servers. This module connects, lists tools once,
 * and calls them. It is not a plugin loader. Tool schemas freeze at
 * connect; a new session reconnects.
 */

// Split into ./mcp/ modules (issue #38). This entry re-exports the public surface.
export { MAX_MCP_JSON_BYTES, MAX_MCP_SERVERS, MAX_MCP_TOOLS, MAX_MCP_TOOL_BYTES, MCP_CALL_MS, MCP_HANDSHAKE_MS, MCP_PROTOCOL, MCP_RESULT_BYTES, jailMcpCwd, loadMcpConfigs, mcpHttpUrlError, parseMcpConfig, userMcpPath } from "./mcp/config.ts";
export type { McpServerConfig } from "./mcp/config.ts";
export { KERNEL_TOOL_NAMES, mcpToolDefs, mcpToolName, mergeClientTools, normalizeMcpTools, sanitizeMcpIdent, selectMcpTools } from "./mcp/tools.ts";
export type { McpClientTool } from "./mcp/tools.ts";
export { createMcpContinuation, normalizeMcpCallResult } from "./mcp/results.ts";
export type { McpCallResult, McpCancellationScope, McpContinuation } from "./mcp/results.ts";
export { mcpEnv, startMcp } from "./mcp/client.ts";
export type { McpSession } from "./mcp/client.ts";
