/**
 * Kernel-sized MCP client (stdio or HTTP).
 *
 * The user config lists servers. This module connects, lists tools once,
 * and calls them. It is not a plugin loader. Tool schemas freeze at
 * connect; a new session reconnects.
 */

// Split into ./mcp/ modules (issue #38). This entry re-exports the public surface.
export { MAX_MCP_JSON_BYTES, MAX_MCP_TOOLS, MAX_MCP_TOOL_BYTES, MCP_PROTOCOL, MCP_RESULT_BYTES, editMcpConfig, inspectMcpConfig, jailMcpCwd, loadMcpConfigs, mcpHttpUrlError, parseMcpConfig, readMcpConfigFile, userMcpPath, writeMcpConfigFile } from "./mcp/config.ts";
export type { McpConfigEdit, McpInventoryEntry } from "./mcp/config.ts";
export { MCP_SLASH_USAGE, formatMcpStatus, parseMcpSlash } from "./mcp/command.ts";
export { KERNEL_TOOL_NAMES, mcpToolDefs, mcpToolName, normalizeInputSchema, normalizeMcpDiscovery, selectMcpTools } from "./mcp/tools.ts";
export { callDiscoveredMcpTool, mcpClientTools, searchMcpTools } from "./mcp/discovery.ts";
export { createMcpContinuation, normalizeMcpCallResult } from "./mcp/results.ts";
export type { McpCancellationScope, McpContinuation } from "./mcp/results.ts";
export { McpHttpStatusError, McpTransportError, mcpEnv, startMcp } from "./mcp/client.ts";
export type { McpServerReport, McpSession } from "./mcp/client.ts";
