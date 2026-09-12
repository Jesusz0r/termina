import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as mcp from "../../../agent-core/mcp.ts";

const PROVIDER_SECRETS: Array<[string, string]> = [
  ["ANTHROPIC_API_KEY", "sk-ant-test-111"],
  ["ANTHROPIC_AUTH_TOKEN", "ant-auth-test-222"],
  ["ANTHROPIC_BASE_URL", "https://ant.test.example"],
  ["OPENAI_API_KEY", "sk-openai-test-333"],
  ["OPENAI_BASE_URL", "https://openai.test.example"],
  ["XAI_API_KEY", "xai-test-444"],
  ["XAI_BASE_URL", "https://xai.test.example"],
  ["GEMINI_API_KEY", "gemini-test-555"],
  ["GOOGLE_API_KEY", "google-test-666"],
  ["OPENROUTER_API_KEY", "or-test-777"],
  ["OPENROUTER_BASE_URL", "https://or.test.example"],
  ["OPENCODE_API_KEY", "opencode-test-888"],
  ["OPENCODE_GO_API_KEY", "opencode-go-test-999"],
];

function withHostEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    const value = vars[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function writeEchoEnvServer(dir: string): string {
  const file = join(dir, "env-mcp.mjs");
  writeFileSync(
    file,
    `process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "env" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "show_env", description: "show env", inputSchema: { type: "object" } }] } }) + "\\n");
    } else if (msg.method === "tools/call") {
      const keys = ["ANTHROPIC_API_KEY","OPENAI_API_KEY","XAI_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","OPENCODE_API_KEY","PI_SESSION_FILE","TERMINA_AUTH_PATH","PATH","HOME","MCP_TEST_MARKER"];
      const out = {};
      for (const k of keys) out[k] = process.env[k] ?? null;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out) }] } }) + "\\n");
    }
  }
});
`,
  );
  return file;
}

function writeSlowFastServer(dir: string): string {
  const file = join(dir, "slowfast-mcp.mjs");
  writeFileSync(
    file,
    `process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let n;
  while ((n = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, n);
    buf = buf.slice(n + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "slowfast" } } }) + "\\n");
    } else if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "slow", description: "slow", inputSchema: { type: "object" } }, { name: "fast", description: "fast", inputSchema: { type: "object" } }] } }) + "\\n");
    } else if (msg.method === "tools/call") {
      const tool = msg.params?.name;
      if (tool === "fast") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "fast-ok" }] } }) + "\\n");
      }
    }
  }
});
`,
  );
  return file;
}

describe("MCP env minting and reconnect", () => {
  it("mints PATH/HOME plus mcp.json env without host provider keys", () => {
    const host: NodeJS.ProcessEnv = {
      PATH: "/tmp/test-path:/usr/bin",
      HOME: "/tmp/test-home",
      ANTHROPIC_API_KEY: "sk-ant-host",
      OPENAI_API_KEY: "sk-openai-host",
      PI_SESSION_FILE: "/tmp/pinned-session",
      TERMINA_AUTH_PATH: "/tmp/auth.json",
    };
    const env = mcp.mcpEnv({ MCP_TEST_MARKER: "marker-123", PI_SMUGGLING: "x" }, host);
    expect(env.PATH).toBe("/tmp/test-path:/usr/bin");
    expect(env.HOME).toBe("/tmp/test-home");
    expect(env.MCP_TEST_MARKER).toBe("marker-123");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PI_SESSION_FILE).toBeUndefined();
    expect(env.TERMINA_AUTH_PATH).toBeUndefined();
    for (const key of Object.keys(env)) expect(key.startsWith("PI_")).toBe(false);
  });

  it("strips PI_* even when mcp.json env declares it, and falls back to a default PATH", () => {
    const env = mcp.mcpEnv({ PI_SESSION_ID: "pinned", CUSTOM_OK: "yes" }, {});
    expect(env.PI_SESSION_ID).toBeUndefined();
    expect(env.CUSTOM_OK).toBe("yes");
    expect(typeof env.PATH).toBe("string");
    expect(String(env.PATH).length).toBeGreaterThan(0);
  });

  it("does not leak host provider keys to a spawned stdio server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-env-"));
    const overrides: Record<string, string> = {
      PATH: "/tmp/mcp-test-path:/usr/bin",
      HOME: "/tmp/mcp-test-home",
      PI_SESSION_FILE: "/tmp/mcp-pinned-session",
      TERMINA_AUTH_PATH: "/tmp/mcp-auth.json",
    };
    for (const [key, value] of PROVIDER_SECRETS) overrides[key] = value;
    const saved = new Map<string, string | undefined>();
    for (const key of Object.keys(overrides)) {
      saved.set(key, process.env[key]);
      process.env[key] = overrides[key]!;
    }
    try {
      const server = writeEchoEnvServer(dir);
      const session = await mcp.startMcp(
        [{ name: "env", command: process.execPath, args: [server], env: { MCP_TEST_MARKER: "marker-123" } }],
        { projectRoot: dir, confineCwd: (cwd) => mcp.jailMcpCwd(dir, cwd) },
      );
      try {
        expect(session.tools.map((tool) => tool.name)).toContain("mcp_env_show_env");
        const result = await session.call("mcp_env_show_env", {});
        expect(result.isError).toBe(false);
        const seen = JSON.parse(result.content) as Record<string, string | null>;
        expect(seen.PATH).toBe("/tmp/mcp-test-path:/usr/bin");
        expect(seen.HOME).toBe("/tmp/mcp-test-home");
        expect(seen.MCP_TEST_MARKER).toBe("marker-123");
        expect(seen.PI_SESSION_FILE).toBeNull();
        expect(seen.TERMINA_AUTH_PATH).toBeNull();
        for (const [, secret] of PROVIDER_SECRETS) expect(result.content).not.toContain(secret);
        expect(seen.ANTHROPIC_API_KEY).toBeNull();
        expect(seen.OPENAI_API_KEY).toBeNull();
        expect(seen.XAI_API_KEY).toBeNull();
        expect(seen.GEMINI_API_KEY).toBeNull();
        expect(seen.OPENROUTER_API_KEY).toBeNull();
        expect(seen.OPENCODE_API_KEY).toBeNull();
      } finally {
        session.shutdown();
      }
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconnects after an interrupt so the next tool on the same server works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-reconnect-interrupt-"));
    try {
      const server = writeSlowFastServer(dir);
      const session = await mcp.startMcp(
        [{ name: "reconnect", command: process.execPath, args: [server], env: {} }],
        { projectRoot: dir, confineCwd: (cwd) => mcp.jailMcpCwd(dir, cwd) },
      );
      try {
        const startedAt = Date.now();
        const interrupted = await session.call("mcp_reconnect_slow", {}, {
          shouldStop: () => Date.now() - startedAt >= 2000,
          timeoutMs: 30_000,
        });
        expect(interrupted.isError).toBe(true);
        expect(interrupted.content).toMatch(/interrupted/);
        expect(Date.now() - startedAt).toBeLessThan(10_000);
        const fast = await session.call("mcp_reconnect_fast", {});
        expect(fast.isError).toBe(false);
        expect(fast.content).toBe("fast-ok");
        expect(fast.content).not.toMatch(/is not running/);
      } finally {
        session.shutdown();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconnects after a timeout so the next tool on the same server works", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-reconnect-timeout-"));
    try {
      const server = writeSlowFastServer(dir);
      const session = await mcp.startMcp(
        [{ name: "reconnect", command: process.execPath, args: [server], env: {} }],
        { projectRoot: dir, confineCwd: (cwd) => mcp.jailMcpCwd(dir, cwd) },
      );
      try {
        const timed = await session.call("mcp_reconnect_slow", {}, { timeoutMs: 200 });
        expect(timed.isError).toBe(true);
        expect(timed.content).toMatch(/timed out/);
        const fast = await session.call("mcp_reconnect_fast", {});
        expect(fast.isError).toBe(false);
        expect(fast.content).toBe("fast-ok");
        expect(fast.content).not.toMatch(/is not running/);
      } finally {
        session.shutdown();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an explicit per-server secret while still minting the host env", () => {
    withHostEnv({}, () => {
      const env = mcp.mcpEnv({ OPENAI_API_KEY: "server-scoped-key" }, { PATH: "/bin", HOME: "/tmp/h" });
      expect(env.OPENAI_API_KEY).toBe("server-scoped-key");
      expect(env.PATH).toBe("/bin");
      expect(env.HOME).toBe("/tmp/h");
    });
  });
});
