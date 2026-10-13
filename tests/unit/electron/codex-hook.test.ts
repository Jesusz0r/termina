import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexActivitySignals, codexHookFacts, observeCodexHookWire } from "../../../electron/external-cli/codex-activity.ts";
import { CodexHookServer, codexSocketPath } from "../../../electron/external-cli/codex-hook-server.ts";
import { codexHome, codexHookCommand, codexLaunchArgs, codexProfileToml, resolveCodexNode, writeCodexHookScript, writeCodexProfile } from "../../../electron/external-cli/codex-launch.ts";

describe("Codex hook facts", () => {
  it("does not start work from a prompt or session open", () => {
    expect(codexHookFacts({ hook_event_name: "UserPromptSubmit", prompt: "fix the login" })).toEqual([]);
    expect(codexHookFacts({ hook_event_name: "SessionStart", source: "startup" })).toEqual([]);
    expect(codexHookFacts({ hook_event_name: "SubagentStart" })).toEqual([]);
    expect(codexHookFacts(null)).toEqual([]);
  });

  it("maps a tool, a permission, a failed result, and a subagent stop", () => {
    expect(codexHookFacts({
      hook_event_name: "PreToolUse",
      tool_name: "apply_patch",
      tool_use_id: "call-1",
    })).toEqual([
      { t: "external_turn" },
      { t: "external_tool", target: "call-1" },
    ]);
    expect(codexHookFacts({ hook_event_name: "PermissionRequest", tool_name: "Bash" })).toEqual([
      { t: "external_turn" },
      { t: "external_permission", requestId: "codex:Bash" },
    ]);
    expect(codexHookFacts({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: "call-2",
      tool_response: { exit_code: 1 },
    })).toEqual([
      { t: "external_turn" },
      { t: "external_permission_clear", requestId: "codex:Bash" },
      { t: "external_tool_end", target: "call-2", isError: true },
    ]);
    expect(codexHookFacts({ hook_event_name: "SubagentStop", agent_id: "child" })).toEqual([
      { t: "external_subagent_stop" },
    ]);
    const signals = codexActivitySignals({ hook_event_name: "PermissionRequest", tool_name: "Bash" }, 4, 40);
    expect(signals[1]).toMatchObject({ t: "intervention_requested", requestId: "codex:Bash", kind: "permission" });
  });
});

describe("Codex launch profile", () => {
  it("adds an observational profile without bypassing hook trust", () => {
    expect(codexLaunchArgs()).toEqual(["-p", "termina"]);
    expect(codexLaunchArgs().join(" ")).not.toContain("dangerously-bypass");
    const command = codexHookCommand(
      "/Users/a/Library/Application Support/node",
      "/Users/a/Library/Application Support/Termina/codex-hook.mjs",
    );
    expect(command).toBe("'/Users/a/Library/Application Support/node' '/Users/a/Library/Application Support/Termina/codex-hook.mjs'");
    const toml = codexProfileToml(command);
    expect(toml).toContain("Application Support");
    expect(toml).toContain("[[hooks.Stop]]");
    expect(toml).toContain("[[hooks.PermissionRequest]]");
    expect(toml).toContain("[[hooks.SubagentStop]]");
    expect(toml).not.toContain("decision");
    expect(toml).not.toContain("bypass");
  });

  it("writes only the Termina profile file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-codex-profile-"));
    await writeCodexProfile(dir, "/opt/termina/codex-hook.mjs");
    const text = await readFile(join(dir, "termina.config.toml"), "utf8");
    expect(text).toContain("[[hooks.UserPromptSubmit]]");
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
    const observed = observeCodexHookWire({ head, tail });
    const facts = codexHookFacts(observed);
    expect(facts).toContainEqual({ t: "external_permission_clear", requestId: "codex:Bash" });
    expect(facts).toContainEqual({ t: "external_tool_end", target: "call-9", isError: true });
  });

  it("ignores a relative CODEX_HOME and finds node beside the codex binary", async () => {
    expect(codexHome({ CODEX_HOME: "relative/codex" }, "/Users/a")).toBe("/Users/a/.codex");
    const dir = await mkdtemp(join(tmpdir(), "termina-node-"));
    await writeFile(join(dir, "node"), "");
    await chmod(join(dir, "node"), 0o755);
    expect(resolveCodexNode(join(dir, "codex"))).toBe(join(dir, "node"));
    const empty = await mkdtemp(join(tmpdir(), "termina-no-node-"));
    expect(resolveCodexNode(join(empty, "codex"), () => null)).toBeNull();
  });
});

describe("Codex hook socket", () => {
  it("drops a message whose token belongs to another terminal", () => {
    const server = new CodexHookServer(() => undefined);
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
    server.revoke("term-1");
    expect(server.accept(JSON.stringify({
      v: 1, token, terminalId: "term-1", generation: 3, payload: "{}",
    }))).toBeNull();
  });

  it("keeps a short socket under user data and refuses to reuse an overlong path", () => {
    expect(codexSocketPath("/tmp/termina", 42)).toBe("/tmp/termina/codex-hook-42.sock");
    const path = codexSocketPath(`/tmp/${"a".repeat(120)}`, 42);
    expect(path.includes("a".repeat(80))).toBe(false);
    expect(path.endsWith("hook.sock")).toBe(true);
  });

  it("delivers a huge tool body as head and tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "th-"));
    const script = join(dir, "hook.mjs");
    const sock = join(dir, "hook.sock");
    await writeCodexHookScript(script);
    const received: Array<{ head?: string; tail?: string; payload?: string }> = [];
    const server = new CodexHookServer((message) => received.push(message));
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
      const facts = codexHookFacts(observeCodexHookWire(received[0]!));
      expect(facts).toContainEqual({ t: "external_permission_clear", requestId: "codex:Bash" });
      expect(facts).toContainEqual({ t: "external_tool_end", target: "call-9", isError: true });
    } finally {
      await server.close();
    }
  });
});
