import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexActivitySignals, codexHookFacts } from "../../../electron/external-cli/codex-activity.ts";
import { CodexHookServer } from "../../../electron/external-cli/codex-hook-server.ts";
import { codexLaunchArgs, codexProfileToml, writeCodexProfile } from "../../../electron/external-cli/codex-launch.ts";

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
    const toml = codexProfileToml("/opt/termina/codex-hook.mjs");
    expect(toml).toContain('command = "/opt/termina/codex-hook.mjs"');
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
});
