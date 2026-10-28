import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { buildFrozenSystem } from "../../../agent-core/main/front-matter.ts";
import { formatDoctor } from "../../../agent-core/main/doctor.ts";
import { formatProjectInstructions, formatUserInstructions } from "../../../agent-core/main/skills.ts";
import { startMcp, type McpSession } from "../../../agent-core/mcp.ts";

const roots: string[] = [];
const sessions: McpSession[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.shutdown();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "termina-doctor-"));
  roots.push(root);
  const userAgentsPath = join(root, "user-AGENTS.md");
  const build = () => buildFrozenSystem({ cwd: root, userAgentsPath, userSkillDir: null, probes: false });
  return { root, userAgentsPath, build };
}

describe("/doctor loader facts (#464)", () => {
  it("reports actual index omissions without printing names, descriptions or bodies", () => {
    const { root, build } = fixture();
    for (let index = 0; index < 12; index++) {
      const dir = join(root, ".agents", "skills", String(index));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: skill-${index}-${"x".repeat(900)}\ndescription: PRIVATE_DESCRIPTION\n---\nPRIVATE_BODY`);
    }
    const built = build();
    expect(built.diagnostics.skills).toEqual({ discovered: 12, omitted: 12, scanCapped: false });
    expect(built.system).toContain("<skill-index/>");
    const text = formatDoctor(built.diagnostics, null);
    expect(text).toContain("Skills: 0 indexed, 12 omitted by index limit");
    expect(text).toContain("Skill scan: complete");
    expect(text).not.toMatch(/PRIVATE|skill-0/);
    expect(formatDoctor({ ...built.diagnostics, skills: { ...built.diagnostics.skills, scanCapped: true } }, null))
      .toContain("Skill scan: capped; additional omissions unknown");
  });

  it("distinguishes missing, loaded and truncated instructions using formatter facts", () => {
    const { root, userAgentsPath, build } = fixture();
    expect(formatDoctor(build().diagnostics, null)).toContain("Project AGENTS.md: not loaded");
    writeFileSync(userAgentsPath, "x".repeat(8192));
    writeFileSync(join(root, "AGENTS.md"), "<!-- AGENTS.md truncated -->");
    expect(build().diagnostics.instructions).toEqual({ user: "loaded", project: "loaded" });
    writeFileSync(userAgentsPath, "x".repeat(8193));
    writeFileSync(join(root, "AGENTS.md"), "y".repeat(24577));
    const built = build();
    expect(built.diagnostics.instructions).toEqual({ user: "truncated", project: "truncated" });
    expect(formatDoctor(built.diagnostics, null)).toContain("User AGENTS.md: truncated");
    expect(formatDoctor(built.diagnostics, null)).toContain("Project AGENTS.md: truncated");
    expect(formatProjectInstructions("y".repeat(24576)).omitted).toBe(0);
    expect(formatUserInstructions("x".repeat(8192), userAgentsPath).omitted).toBe(0);
  });

  it("keeps credentials, auth contents, environment values and raw MCP errors out of the report", async () => {
    vi.stubEnv("TERMINA_CORE_TEST", "1");
    const { root, userAgentsPath, build } = fixture();
    writeFileSync(userAgentsPath, "PRIVATE_INSTRUCTIONS");
    writeFileSync(join(root, "auth.json"), '{"key":"PRIVATE_AUTH_FILE"}');
    let rejectRpc = true;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk.toString(); });
      request.on("end", () => {
        const rpc = JSON.parse(body);
        if (request.url?.startsWith("/auth")) { response.writeHead(401).end("PRIVATE_HEADER PRIVATE_ENV"); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(rejectRpc
          ? { jsonrpc: "2.0", id: rpc.id, error: { code: "PRIVATE_ERROR_CODE", message: "PRIVATE_ENV PRIVATE_HEADER PRIVATE_URL" } }
          : { jsonrpc: "2.0", id: rpc.id, result: rpc.method === "tools/list" ? { tools: [] } : {} }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback port");
    const configs: Parameters<typeof startMcp>[0] = [
      { name: "rpc", args: [], env: { TOKEN: "PRIVATE_ENV" }, url: `http://127.0.0.1:${address.port}/rpc?token=PRIVATE_URL`, headers: { Authorization: "Bearer PRIVATE_HEADER" } },
      { name: "auth", args: [], env: {}, url: `http://127.0.0.1:${address.port}/auth` },
      { name: "missing", command: join(root, "PRIVATE_COMMAND"), args: ["PRIVATE_ARG"], env: { KEY: "PRIVATE_ENV" } },
    ];
    const session = await startMcp(configs, { projectRoot: root, confineCwd: () => root });
    sessions.push(session);
    expect(session.notes.join("\n")).toContain("PRIVATE_ENV");
    const text = formatDoctor(build().diagnostics, session);
    expect(text).toContain('"rpc": failed (MCP_CONNECT_FAILED)');
    expect(text).toContain('"auth": needs-authentication (HTTP_401)');
    expect(text).toContain('"missing": failed (ENOENT)');
    expect(text).not.toMatch(/PRIVATE|Bearer|127\.0\.0\.1|auth\.json/);
    rejectRpc = false;
    await session.connect([configs[0]!]);
    const recovered = formatDoctor(build().diagnostics, session);
    expect(recovered).toContain("MCP connection failures: 2");
    expect(recovered).not.toContain('"rpc":');
  });
});
