/** `/doctor` renders loader facts only; never config, instruction bodies or MCP notes. */
import type { FrontMatterDiagnostics } from "./front-matter.ts";
import type { McpSession } from "../mcp.ts";

export function formatDoctor(diagnostics: FrontMatterDiagnostics, session: Pick<McpSession, "servers"> | null): string {
  const { skills, instructions } = diagnostics;
  const lines = [
    "Doctor",
    `Skills: ${skills.discovered - skills.omitted} indexed, ${skills.omitted} omitted by index limit`,
    `Skill scan: ${skills.scanCapped ? "capped; additional omissions unknown" : "complete"}`,
    `User AGENTS.md: ${instructions.user}`,
    `Project AGENTS.md: ${instructions.project}`,
  ];
  const failures = session?.servers.filter(server => server.state !== "connected") ?? [];
  lines.push(`MCP connection failures: ${failures.length}${session ? "" : " (no connection results)"}`);
  for (const server of failures) {
    lines.push(`  ${JSON.stringify(server.name)}: ${server.state} (${server.errorCode})`);
  }
  return lines.join("\n");
}
