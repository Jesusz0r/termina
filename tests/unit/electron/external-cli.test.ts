import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { externalHookFacts, observeCodexHookWire } from "../../../electron/external-cli/codex-activity.ts";
import {
  claudeLaunchArgs,
  installClaudeSettings,
  installGeminiSettings,
  installGrokHooks,
  installMuseHooks,
} from "../../../electron/external-cli/install-hooks.ts";

describe("external CLI hook facts", () => {
  it("keeps Claude notifications from becoming a permission and marks tool failures", () => {
    expect(externalHookFacts("claude", { hook_event_name: "Notification", notification_type: "idle_prompt" })).toEqual([]);
    expect(externalHookFacts("claude", { hook_event_name: "PostToolUseFailure", tool_name: "Edit", tool_use_id: "c1" }))
      .toContainEqual({ t: "external_tool_end", target: "c1", isError: true });
    expect(externalHookFacts("claude", { hook_event_name: "StopFailure" })).toEqual([{ t: "external_stop" }]);
  });

  it("reads Grok camelCase and snake_case without inventing a permission hook", () => {
    const observed = observeCodexHookWire({
      payload: JSON.stringify({ hookEventName: "pre_tool_use", toolName: "bash", toolUseId: "g1" }),
    });
    expect(externalHookFacts("grok", observed)).toEqual([
      { t: "external_turn" },
      { t: "external_tool", target: "g1" },
    ]);
    expect(externalHookFacts("grok", { hookEventName: "PreToolUse", toolName: "bash", toolUseId: "g1" })).toEqual([
      { t: "external_turn" },
      { t: "external_tool", target: "g1" },
    ]);
    expect(externalHookFacts("grok", { hook_event_name: "post_tool_use", tool_name: "bash" }).some((fact) => fact.t === "external_tool_end")).toBe(true);
    expect(externalHookFacts("grok", { hookEventName: "Notification" })).toEqual([]);
  });

  it("maps Gemini planning, tools, and permission notices", () => {
    expect(externalHookFacts("gemini", { hook_event_name: "BeforeAgent", prompt: "ship it" })).toEqual([]);
    expect(externalHookFacts("gemini", { hook_event_name: "BeforeTool", tool_name: "write_file" })[0]).toEqual({ t: "external_turn" });
    const noticed = observeCodexHookWire({
      payload: JSON.stringify({ hook_event_name: "Notification", type: "ToolPermission", tool_name: "write_file" }),
    });
    expect(externalHookFacts("gemini", noticed))
      .toContainEqual({ t: "external_permission", requestId: "gemini:write_file" });
    expect(externalHookFacts("gemini", { hook_event_name: "Notification", type: "Info" })).toEqual([]);
    expect(externalHookFacts("gemini", { hook_event_name: "AfterAgent" })).toEqual([{ t: "external_stop" }]);
    expect(externalHookFacts("gemini", { hook_event_name: "AfterTool", tool_name: "run_shell", error: "denied" }))
      .toContainEqual({ t: "external_tool_end", target: "run_shell", isError: true });
  });

  it("treats a Muse notification as an approval wait and ignores the prompt itself", () => {
    expect(externalHookFacts("muse", { hook_event_name: "UserPromptSubmit", prompt: "refactor" })).toEqual([]);
    expect(externalHookFacts("muse", { hook_event_name: "Notification", tool_name: "Bash" }))
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
    await expect(installMuseHooks(dir, "/opt/node /opt/hook.mjs")).rejects.toThrow();
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe("{");
  });

  it("merges Gemini hooks into user settings and leaves other keys", async () => {
    const dir = await mkdtemp(join(tmpdir(), "termina-gemini-"));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ model: "gemini-pro", hooks: { BeforeTool: [{ hooks: [{ command: "user-check" }] }] } }));
    await installGeminiSettings(dir, "/opt/node /opt/external-hook.mjs");
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as { model: string; hooks: { BeforeTool: unknown[] } };
    expect(settings.model).toBe("gemini-pro");
    expect(JSON.stringify(settings.hooks)).toContain("user-check");
    expect(JSON.stringify(settings.hooks)).toContain("external-hook.mjs");
    await writeFile(join(dir, "settings.json"), "{");
    await expect(installGeminiSettings(dir, "/opt/node /opt/external-hook.mjs")).rejects.toThrow();
    expect(await readFile(join(dir, "settings.json"), "utf8")).toBe("{");
  });
});
