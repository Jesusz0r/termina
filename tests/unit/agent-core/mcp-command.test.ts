import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editMcpConfig, formatMcpStatus, inspectMcpConfig, mcpServersNamedIn, parseMcpSlash, readMcpConfigFile, writeMcpConfigFile, type McpConfigEdit } from "../../../agent-core/mcp.ts";

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
    expect(text).toContain("names a server");
  });

  it("connects only servers the prompt names", () => {
    expect(mcpServersNamedIn("do something on vercel, then check inngest", ["vercel", "inngest", "blender"])).toEqual(["vercel", "inngest"]);
    expect(mcpServersNamedIn("investigation notes", ["inngest"])).toEqual([]);
    expect(mcpServersNamedIn("use ai", ["ai"])).toEqual([]);
  });

  it("matches complete names with punctuation, preserving configured spelling and order", () => {
    expect(mcpServersNamedIn("Use BLENDER-MCP, github_tools and docs.api.", ["docs.api", "github_tools", "Blender-MCP"])).toEqual([
      "docs.api", "github_tools", "Blender-MCP",
    ]);
  });

  it.each([
    ["blender-mcp", ["blender", "mcp", "blender-mcp"]],
    ["github_tools", ["github", "tools", "github_tools"]],
    ["docs.api", ["docs", "api", "docs.api"]],
  ])("does not connect pieces of %s, even if the full name is not configured", (name, names) => {
    expect(mcpServersNamedIn(`use ${name}`, names)).toEqual([name]);
    expect(mcpServersNamedIn(`use ${name}`, names.filter(candidate => candidate !== name))).toEqual([]);
  });

  it.each(["prefixdocs.api", "docs.api.extra", "docs.api_suffix", "blender-mcp-extra", "xgithub_tools", "github_tools2"])(
    "does not match names embedded in %s", text => {
      expect(mcpServersNamedIn(`use ${text}`, ["docs.api", "blender-mcp", "github_tools"])).toEqual([]);
    },
  );

  it("allows quotes, backticks, parentheses, and sentence punctuation around names", () => {
    expect(mcpServersNamedIn('Use "blender-mcp", `github_tools`, and (docs.api).', ["blender-mcp", "github_tools", "docs.api"])).toEqual([
      "blender-mcp", "github_tools", "docs.api",
    ]);
  });

  it("keeps compact comma-separated mentions and returns repeated names only once", () => {
    expect(mcpServersNamedIn("vercel,inngest;docs.api. Use VERCEL again.", ["docs.api", "vercel", "inngest"])).toEqual([
      "docs.api", "vercel", "inngest",
    ]);
  });

  it.each(["docs+api", "docs*api", "docs?api", "docs[api]", "docs(api)", "docs{api}", "docs|api", "docs^api", "docs$api", "docs\\api"])(
    "treats configured name %s literally, rather than as a regular expression", name => {
      expect(mcpServersNamedIn(`use "${name}"`, ["docs", "api", name])).toEqual([name]);
      expect(mcpServersNamedIn("use docsXapi or docsapi", [name])).toEqual([]);
    },
  );

  it.each(["docs+api", "docs*api", "docs?api", "docs[api]", "docs(api)", "docs{api}", "docs|api", "docs^api", "docs$api", "docs\\api"])(
    "does not select shorter pieces of an embedded or extended %s", name => {
      expect(mcpServersNamedIn(`use ${name}-extra`, ["docs", "api", name])).toEqual([]);
      expect(mcpServersNamedIn(`use x${name}`, ["docs", "api", name])).toEqual([]);
    },
  );

  it("prefers the longest literal name when a final period is ambiguous", () => {
    expect(mcpServersNamedIn("use docs.api.", ["docs.api"])).toEqual(["docs.api"]);
    expect(mcpServersNamedIn("use docs.api.", ["docs.api", "docs.api."])).toEqual(["docs.api."]);
    expect(mcpServersNamedIn('use "docs.api"', ["docs.api.", "docs.api"])).toEqual(["docs.api"]);
    expect(mcpServersNamedIn("use docs.api. then docs.api", ["docs.api", "docs.api."])).toEqual(["docs.api", "docs.api."]);
  });

  it("matches literal names containing list delimiters before interpreting a list", () => {
    expect(mcpServersNamedIn("docs,api,vercel;docs;api", ["docs", "api", "docs,api", "docs;api", "vercel"])).toEqual([
      "docs,api", "docs;api", "vercel",
    ]);
  });

  it("handles long punctuation runs without repeated suffix scans", () => {
    const quotes = '"'.repeat(100_000);
    expect(mcpServersNamedIn(quotes + "x", ['"""'])).toEqual([]);
    expect(mcpServersNamedIn(quotes, ['"""'])).toEqual(['"""']);
  });

  it("still ignores names shorter than three characters", () => {
    expect(mcpServersNamedIn("use AI, db, x and ai-tools", ["AI", "db", "x", "ai-tools"])).toEqual(["ai-tools"]);
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

  it("narrows the edit payload after list and reconnect return", () => {
    const editFromSlash = (line: string): McpConfigEdit | null => {
      const parsed = parseMcpSlash(line);
      if ("error" in parsed) return null;
      if (parsed.action === "list") return null;
      if (parsed.action === "reconnect") return null;
      return parsed.edit;
    };
    expect(editFromSlash("/mcp")).toBeNull();
    expect(editFromSlash("/mcp reconnect")).toBeNull();
    expect(editFromSlash("/mcp unknown")).toBeNull();
    for (const op of ["remove", "disable", "enable"] as const) {
      expect(editFromSlash(`/mcp ${op} local`)).toEqual({ op, name: "local" });
    }
    expect(editFromSlash("/mcp add stdio local -- node server.mjs")).toEqual({
      op: "add-stdio", name: "local", command: "node", args: ["server.mjs"],
    });
  });

  it("narrows the stdio payload after other config operations return", () => {
    const stdioPayload = (edit: McpConfigEdit) => {
      if (edit.op === "remove") return null;
      if (edit.op === "disable" || edit.op === "enable") return null;
      if (edit.op === "add-http") return null;
      return { command: edit.command, args: edit.args };
    };
    const edits: McpConfigEdit[] = [
      { op: "remove", name: "local" },
      { op: "disable", name: "local" },
      { op: "enable", name: "local" },
      { op: "add-http", name: "docs", url: "https://example.com/mcp" },
      { op: "add-stdio", name: "local", command: "node", args: ["server.mjs"] },
    ];
    expect(edits.map(stdioPayload)).toEqual([null, null, null, null, { command: "node", args: ["server.mjs"] }]);
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
