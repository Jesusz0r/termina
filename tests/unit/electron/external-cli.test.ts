import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hookFacts, observeHookWire } from "../../../electron/external-cli/activity.ts";
import { installAgyHooks } from "../../../electron/external-cli/agy.ts";
import { claudeLaunchArgs, installClaudeSettings } from "../../../electron/external-cli/claude.ts";
import { installGrokHooks } from "../../../electron/external-cli/grok.ts";
import { writeJson } from "../../../electron/external-cli/hook-config.ts";
import { installMuseHooks } from "../../../electron/external-cli/muse.ts";

describe("external CLI hook facts", () => {
  it("keeps Claude notifications from becoming a permission and marks tool failures", () => {
    expect(hookFacts("claude", { hook_event_name: "Notification", notification_type: "idle_prompt" })).toEqual([]);
    expect(hookFacts("claude", { hook_event_name: "PostToolUseFailure", tool_name: "Edit", tool_use_id: "c1" }))
      .toContainEqual({ t: "external_tool_end", target: "c1", isError: true });
    expect(hookFacts("claude", { hook_event_name: "StopFailure" })).toEqual([{ t: "external_stop" }]);
  });

  it("reads Grok camelCase and snake_case without inventing a permission hook", () => {
    const observed = observeHookWire({
      payload: JSON.stringify({ hookEventName: "pre_tool_use", toolName: "bash", toolUseId: "g1" }),
    });
    expect(hookFacts("grok", observed)).toEqual([
      { t: "external_turn" },
      { t: "external_tool", target: "g1" },
    ]);
    expect(hookFacts("grok", { hookEventName: "PreToolUse", toolName: "bash", toolUseId: "g1" })).toEqual([
      { t: "external_turn" },
      { t: "external_tool", target: "g1" },
    ]);
    expect(hookFacts("grok", { hook_event_name: "post_tool_use", tool_name: "bash" }).some((fact) => fact.t === "external_tool_end")).toBe(true);
    expect(hookFacts("grok", { hookEventName: "Notification" })).toEqual([]);
  });

  it("maps Antigravity CLI tool calls and does not treat a model call as a stop", () => {
    const started = observeHookWire({
      payload: JSON.stringify({
        hook_event_name: "PreToolUse",
        toolCall: { name: "run_command", args: { CommandLine: "npm test" } },
        stepIdx: 3,
      }),
    });
    expect(hookFacts("gemini", started)).toEqual([
      { t: "external_turn" },
      { t: "external_tool", target: "step:3" },
    ]);
    expect(hookFacts("gemini", { hook_event_name: "PreInvocation", invocationNum: 0 })).toEqual([{ t: "external_turn" }]);
    expect(hookFacts("gemini", { hook_event_name: "PostInvocation" })).toEqual([]);
    expect(hookFacts("gemini", { hook_event_name: "Stop", terminationReason: "model_stop", fullyIdle: true })).toEqual([{ t: "external_stop" }]);
    expect(hookFacts("gemini", {
      hook_event_name: "PostToolUse",
      toolCall: { name: "run_command" },
      stepIdx: 3,
      error: "exit status 1",
    })).toContainEqual({ t: "external_tool_end", target: "step:3", isError: true });
    expect(hookFacts("gemini", {
      hook_event_name: "PostToolUse",
      toolCall: { name: "run_command" },
      stepIdx: 3,
      error: "",
    })).toContainEqual({ t: "external_tool_end", target: "step:3", isError: false });
    expect(hookFacts("claude", { hook_event_name: "PreInvocation" })).toEqual([]);
    const split = observeHookWire({
      head: `{"hook_event_name":"PostToolUse","toolCall":{"name":"run_command","args":{"CommandLine":"${"x".repeat(40)}`,
      tail: `"}},"stepIdx":7,"error":"exit status 1"}`,
    });
    expect(hookFacts("gemini", split)).toContainEqual({ t: "external_tool_end", target: "step:7", isError: true });
  });

  it("treats a Muse notification as an approval wait and ignores the prompt itself", () => {
    expect(hookFacts("muse", { hook_event_name: "UserPromptSubmit", prompt: "refactor" })).toEqual([]);
    expect(hookFacts("muse", { hook_event_name: "Notification", tool_name: "Bash" }))
      .toContainEqual({ t: "external_permission", requestId: "muse:Bash" });
  });
});

describe("external CLI hook install", () => {
  it("adds Claude settings for one launch and a Grok file beside other hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-cli-"));
    const settings = await installClaudeSettings(dir, "/opt/node /opt/hook.mjs");
    expect(claudeLaunchArgs(settings)).toEqual(["--settings", settings]);
    const grok = join(dir, "grok");
    await writeFile(join(grok, "hooks", "mine.json"), "{}\n").catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(grok, "hooks"), { recursive: true });
      await writeFile(join(grok, "hooks", "mine.json"), "{}\n");
    });
    await installGrokHooks(grok, "/opt/node /opt/hook.mjs");
    expect(await readFile(join(grok, "hooks", "mine.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(grok, "hooks", "termina.json"), "utf8")).toContain("PostToolUse");
  });

  it("points Muse at a managed file without replacing another managed path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-muse-"));
    await installMuseHooks(dir, "/opt/node /opt/hook.mjs");
    const created = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as { schema_version: number; managed_hooks_path: string };
    expect(created.schema_version).toBe(1);
    expect(created.managed_hooks_path).toBe(join(dir, "termina-hooks.json"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ schema_version: 1, theme: "dark", managed_hooks_path: "/other/hooks.json" }));
    await installMuseHooks(dir, "/opt/node /opt/hook.mjs");
    const kept = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as { theme: string; managed_hooks_path: string; hooks: { Stop: unknown } };
    expect(kept.theme).toBe("dark");
    expect(kept.managed_hooks_path).toBe("/other/hooks.json");
    expect(JSON.stringify(kept.hooks)).toContain("/opt/node /opt/hook.mjs");
    await writeFile(join(dir, "settings.json"), "{");
    const managedBefore = await readFile(join(dir, "termina-hooks.json"), "utf8");
    await expect(installMuseHooks(dir, "/opt/node /opt/hook.mjs")).rejects.toThrow();
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe("{");
    expect(await readFile(join(dir, "termina-hooks.json"), "utf8")).toBe(managedBefore);
  });

  it("adds Antigravity hooks beside other hook names and refuses invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-agy-"));
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(join(dir, "config", "hooks.json"), JSON.stringify({ "safety-gate": { enabled: false } }));
    await installAgyHooks(dir, "/opt/node /opt/external-hook.mjs");
    const hooks = JSON.parse(await readFile(join(dir, "config", "hooks.json"), "utf8")) as {
      "safety-gate": { enabled: boolean };
      "termina-observe": { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }> };
    };
    expect(hooks["safety-gate"].enabled).toBe(false);
    expect(hooks["termina-observe"].PreToolUse[0]?.matcher).toBe("*");
    expect(hooks["termina-observe"].PreToolUse[0]?.hooks[0]?.command).toContain("TERMINA_HOOK_EVENT=PreToolUse");
    expect(hooks["termina-observe"].PreToolUse[0]?.hooks[0]?.timeout).toBe(5);
    await writeFile(join(dir, "config", "hooks.json"), "{");
    await expect(installAgyHooks(dir, "/opt/node /opt/external-hook.mjs")).rejects.toThrow();
    expect(await readFile(join(dir, "config", "hooks.json"), "utf8")).toBe("{");
    const blocked = join(dir, "not-a-file");
    await mkdir(blocked);
    await expect(writeJson(blocked, { ok: true })).rejects.toThrow();
  });
});
