import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editMcpConfig, formatMcpStatus, inspectMcpConfig, parseMcpSlash, readMcpConfigFile, writeMcpConfigFile } from "../../../agent-core/mcp.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("/mcp config", () => {
  it("lists auth posture without secrets and marks a 401 as needing authentication", () => {
    const text = formatMcpStatus(inspectMcpConfig({
      mcpServers: {
        docs: { type: "http", url: "https://example.com/mcp?token=secret", headers: { Authorization: "Bearer secret" } },
        local: { command: "npx", args: ["-y", "secret-server"], env: { TOKEN: "secret" } },
        off: { command: "npx", disabled: true },
      },
    }), [
      { name: "docs", state: "needs-authentication", tools: 0 },
      { name: "local", state: "connected", tools: 2 },
    ]);
    expect(text).toContain("docs  needs authentication  http example.com  auth header");
    expect(text).toContain("local  connected  stdio npx  2 tools  auth env");
    expect(text).toContain("off  disabled  stdio npx  auth none");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("Bearer");
    expect(text).toContain("No OAuth login");
  });

  it("parses add, remove, and reconnect without treating server flags as its own", () => {
    expect(parseMcpSlash("/mcp")).toEqual({ action: "list" });
    expect(parseMcpSlash("/mcp reconnect")).toEqual({ action: "reconnect" });
    expect(parseMcpSlash("/mcp add http docs https://example.com/mcp")).toEqual({
      action: "edit",
      edit: { op: "add-http", name: "docs", url: "https://example.com/mcp" },
    });
    expect(parseMcpSlash("/mcp add stdio local -- npx -y server --port 9")).toEqual({
      action: "edit",
      edit: { op: "add-stdio", name: "local", command: "npx", args: ["-y", "server", "--port", "9"] },
    });
    expect(parseMcpSlash("/mcp add stdio local npx")).toHaveProperty("error");
  });

  it("refuses a non-https URL, a ninth server, and writes a durable config", async () => {
    expect(editMcpConfig({ mcpServers: {} }, { op: "add-http", name: "web", url: "http://example.com/mcp" }).ok).toBe(false);
    const servers = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`s${i}`, { command: "npx" }]));
    expect(editMcpConfig({ mcpServers: servers }, { op: "add-stdio", name: "extra", command: "npx", args: [] }).ok).toBe(false);
    const added = editMcpConfig({ mcpServers: {} }, { op: "add-stdio", name: "local", command: "npx", args: ["-y", "srv"] });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const root = mkdtempSync(join(tmpdir(), "mcp-command-"));
    roots.push(root);
    const path = join(root, "agent", "mcp.json");
    await writeMcpConfigFile(path, added.value);
    const read = readMcpConfigFile(path);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(inspectMcpConfig(read.value).map((row) => row.name)).toEqual(["local"]);
    expect(readFileSync(path, "utf8")).toContain("\"command\": \"npx\"");
    const mode = (await import("node:fs")).statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
