import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookActivitySignals, hookFacts, observeHookWire } from "../../../electron/external-cli/activity.ts";
import { HookServer, hookSocketPath } from "../../../electron/external-cli/hook-server.ts";
import { hookCommand, resolveHookNode, writeHookScript } from "../../../electron/external-cli/hook-script.ts";
import { codexHome, codexLaunchArgs, installCodexHooks } from "../../../electron/external-cli/codex.ts";

describe("Codex hook facts", () => {
  it("does not start work from a prompt or session open", () => {
    expect(hookFacts("codex", { hook_event_name: "UserPromptSubmit", prompt: "fix the login" })).toEqual([]);
    expect(hookFacts("codex", { hook_event_name: "SessionStart", source: "startup" })).toEqual([]);
    expect(hookFacts("codex", { hook_event_name: "SubagentStart" })).toEqual([]);
    expect(hookFacts("codex", null)).toEqual([]);
  });

  it("maps a tool, a permission, a failed result, and a subagent stop", () => {
    expect(hookFacts("codex", {
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_use_id: "call-1",
    })).toEqual([
      { t: "external_turn" },
      { t: "external_tool", target: "call-1" },
    ]);
    expect(hookFacts("codex", { hook_event_name: "PermissionRequest", tool_name: "Bash" })).toEqual([
      { t: "external_turn" },
      { t: "external_permission", requestId: "codex:Bash" },
    ]);
    expect(hookFacts("codex", {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "call-2",
      tool_response: { exit_code: 1 },
    })).toEqual([
      { t: "external_turn" },
      { t: "external_permission_clear", requestId: "codex:Bash" },
      { t: "external_tool_end", target: "call-2", isError: true },
    ]);
    expect(hookFacts("codex", { hook_event_name: "SubagentStop", agent_id: "child" })).toEqual([
      { t: "external_subagent_stop" },
    ]);
    const signals = hookActivitySignals("codex", { hook_event_name: "PermissionRequest", tool_name: "Bash" }, 4, 40);
    expect(signals[1]).toMatchObject({ t: "intervention_requested", requestId: "codex:Bash", kind: "permission" });
  });
});

describe("Codex launch hooks", () => {
  it("launches Codex without a profile flag or a hook-trust bypass", () => {
    expect(codexLaunchArgs()).toEqual([]);
    expect(codexLaunchArgs().join(" ")).not.toContain("dangerously-bypass");
    const command = hookCommand(
      "/Users/a/Library/Application Support/node",
      "/Users/a/Library/Application Support/Termina/codex-hook.mjs",
    );
    expect(command).toBe("'/Users/a/Library/Application Support/node' '/Users/a/Library/Application Support/Termina/codex-hook.mjs'");
  });

  it("writes user hooks and removes the old Termina profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-codex-profile-"));
    await writeFile(join(dir, "termina.config.toml"), "old profile\n");
    await writeFile(join(dir, "hooks.json"), JSON.stringify({ model: "kept" }));
    await installCodexHooks(dir, "TERMINA_EXTERNAL_CLI=codex /opt/termina/codex-hook.mjs");
    const hooks = JSON.parse(await readFile(join(dir, "hooks.json"), "utf8")) as { model: string; hooks: { Stop: unknown } };
    expect(hooks.model).toBe("kept");
    expect(JSON.stringify(hooks.hooks)).toContain("TERMINA_EXTERNAL_CLI=codex");
    expect(JSON.stringify(hooks.hooks)).toContain("PermissionRequest");
    await expect(readFile(join(dir, "termina.config.toml"), "utf8")).rejects.toThrow();
  });
});

describe("Codex hook wire", () => {
  it("reads the tool name from the head and the exit code from the tail of a huge body", () => {
    const head = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "x".repeat(100) },
    }).slice(0, 180);
    const tail = `,"tool_response":{"exit_code":2},"tool_use_id":"call-9"}`;
    const observed = observeHookWire({ head, tail });
    const facts = hookFacts("codex", observed);
    expect(facts).toContainEqual({ t: "external_permission_clear", requestId: "codex:Bash" });
    expect(facts).toContainEqual({ t: "external_tool_end", target: "call-9", isError: true });
  });

  it("ignores a relative CODEX_HOME and finds node beside the codex binary", async () => {
    expect(codexHome({ CODEX_HOME: "relative/codex" }, "/Users/a")).toBe("/Users/a/.codex");
    const dir = await mkdtemp(join(tmpdir(), "termina-node-"));
    await writeFile(join(dir, "node"), "");
    await chmod(join(dir, "node"), 0o755);
    expect(resolveHookNode(join(dir, "codex"))).toBe(join(dir, "node"));
    const empty = await mkdtemp(join(tmpdir(), "termina-no-node-"));
    expect(resolveHookNode(join(empty, "codex"), () => null)).toBeNull();
  });
});

describe("Codex hook socket", () => {
  it("drops a message whose token belongs to another terminal", () => {
    const server = new HookServer(() => undefined);
    const token = server.issue("term-1", 3);
    expect(server.accept(JSON.stringify({
      v: 1, token, terminalId: "term-2", generation: 3, payload: "{}",
    }))).toBeNull();
    expect(server.accept(JSON.stringify({
      v: 1, token, terminalId: "term-1", generation: 4, payload: "{}",
    }))).toBeNull();
    expect(server.accept(JSON.stringify({
      v: 1, token, terminalId: "term-1", generation: 3, payload: "{\"hook_event_name\":\"Stop\"}",
    }))?.payload).toContain("Stop");
    expect(server.accept(JSON.stringify({
      v: 1, token, terminalId: "term-1", generation: 3, cli: "gemini", payload: "{}",
    }))?.cli).toBe("gemini");
    expect(server.accept(JSON.stringify({
      v: 1, token, terminalId: "term-1", generation: 3, cli: "not-a-cli", payload: "{}",
    }))).toBeNull();
    server.revoke("term-1");
    expect(server.accept(JSON.stringify({
      v: 1, token, terminalId: "term-1", generation: 3, payload: "{}",
    }))).toBeNull();
  });

  it("keeps a short socket under user data and refuses to reuse an overlong path", () => {
    expect(hookSocketPath("/tmp/termina", 42)).toBe("/tmp/termina/external-hook-42.sock");
    const path = hookSocketPath(`/tmp/${"a".repeat(120)}`, 42);
    expect(path.includes("a".repeat(80))).toBe(false);
    expect(path.endsWith("hook.sock")).toBe(true);
  });

  it("delivers a huge tool body as head and tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "th-"));
    const script = join(dir, "hook.mjs");
    const sock = join(dir, "hook.sock");
    await writeHookScript(script);
    const received: Array<{ head?: string; tail?: string; payload?: string }> = [];
    const server = new HookServer((message) => received.push(message));
    await server.listen(sock);
    const token = server.issue("term-1", 1);
    const body = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "call-9",
      tool_input: { command: "x".repeat(80_000) },
      tool_response: { exit_code: 2 },
    });
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          env: {
            TERMINA_EXTERNAL_HOOK_SOCKET: sock,
            TERMINA_EXTERNAL_HOOK_TOKEN: token,
            TERMINA_TERMINAL_ID: "term-1",
            TERMINA_TERMINAL_GENERATION: "1",
          },
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("hook script timed out"));
        }, 3000);
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("exit", (status) => { clearTimeout(timer); resolve(status ?? 1); });
        child.stdin.end(body);
      });
      expect(code).toBe(0);
      expect(received).toHaveLength(1);
      const facts = hookFacts("codex", observeHookWire(received[0]!));
      expect(facts).toContainEqual({ t: "external_permission_clear", requestId: "codex:Bash" });
      expect(facts).toContainEqual({ t: "external_tool_end", target: "call-9", isError: true });
    } finally {
      await server.close();
    }
  });

  it("stamps the Antigravity event onto a payload that does not name one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "th-stamp-"));
    const script = join(dir, "hook.mjs");
    const sock = join(dir, "hook.sock");
    await writeHookScript(script);
    const received: Array<{ payload?: string; cli?: string }> = [];
    const server = new HookServer((message) => received.push(message));
    await server.listen(sock);
    const token = server.issue("term-1", 1);
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          env: {
            TERMINA_EXTERNAL_HOOK_SOCKET: sock,
            TERMINA_EXTERNAL_HOOK_TOKEN: token,
            TERMINA_TERMINAL_ID: "term-1",
            TERMINA_TERMINAL_GENERATION: "1",
            TERMINA_HOOK_EVENT: "Stop",
          },
        });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("hook script timed out"));
        }, 3000);
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("exit", (status) => { clearTimeout(timer); resolve(status ?? 1); });
        child.stdin.end(`\n\n{"fullyIdle":true,"note":"${"x".repeat(500)} hook_event_name"}`);
      });
      expect(code).toBe(0);
      expect(received[0]?.cli).toBe("gemini");
      expect(received[0]?.payload).toContain('"hook_event_name":"Stop"');
      expect(hookFacts("gemini", observeHookWire(received[0]!))).toEqual([{ t: "external_stop" }]);
    } finally {
      await server.close();
    }
  });

  it("lets every Antigravity tool proceed and leaves other CLIs undecided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "th-reply-"));
    const script = join(dir, "hook.mjs");
    await writeHookScript(script);
    async function reply(env: Record<string, string>): Promise<string> {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script], { env });
        let stdout = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("hook reply timed out"));
        }, 3000);
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("exit", (status) => {
          clearTimeout(timer);
          if (status !== 0) reject(new Error(`hook reply exited ${status}`));
          else resolve(stdout);
        });
        child.stdin.end('{"toolCall":{"name":"write_to_file"}}');
      });
    }
    const allow = '{"decision":"allow"}\n';
    expect(await reply({ TERMINA_HOOK_EVENT: "PreToolUse" })).toBe(allow);
    expect(await reply({ TERMINA_EXTERNAL_CLI: "gemini", TERMINA_HOOK_EVENT: "PreToolUse" })).toBe(allow);
    expect(await reply({ TERMINA_EXTERNAL_CLI: "gemini", TERMINA_HOOK_EVENT: "Stop" })).toBe(allow);
    expect(await reply({ TERMINA_EXTERNAL_CLI: "gemini", TERMINA_HOOK_EVENT: "PostToolUse" })).toBe("{}\n");
    expect(await reply({ TERMINA_EXTERNAL_CLI: "gemini", TERMINA_HOOK_EVENT: "PreInvocation" })).toBe("{}\n");
    for (const cli of ["codex", "claude", "grok", "muse"]) {
      expect(await reply({ TERMINA_EXTERNAL_CLI: cli, TERMINA_HOOK_EVENT: "PreToolUse" })).toBe("{}\n");
      expect(await reply({ TERMINA_EXTERNAL_CLI: cli, TERMINA_HOOK_EVENT: "Stop" })).toBe("{}\n");
    }
    expect(await reply({})).toBe("{}\n");
  });
});
