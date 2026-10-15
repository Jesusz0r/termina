import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EXTERNAL_CLIS, type ExternalCli } from "../../shared/types.ts";
import { shellQuote } from "../../electron/external-cli/hook-script.ts";
import { test, expect } from "./fixtures.ts";

async function installedCommand(home: string, cli: ExternalCli, event: string): Promise<string> {
  const paths: Record<ExternalCli, string> = {
    codex: join(home, ".codex", "hooks.json"),
    claude: join(home, ".claude", "settings.json"),
    grok: join(home, ".grok", "hooks", "termina.json"),
    gemini: join(home, ".gemini", "config", "hooks.json"),
    muse: join(home, ".config", "muse", "termina-hooks.json"),
  };
  const config = JSON.parse(await readFile(paths[cli], "utf8"));
  const group = (cli === "gemini" ? config["termina-observe"] : config.hooks)[event][0];
  const command = (group.hooks ? group.hooks[0] : group).command;
  expect(typeof command).toBe("string");
  return command;
}

test("installed CLI hooks reach terminal activity and project attention through a real shell", async ({ page, electronApp, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const home = join(runRoot, "home");
  // Host config overrides must not redirect hook installation outside this fixture.
  await electronApp.evaluate((_, roots) => { Object.assign(process.env, roots); }, {
    CODEX_HOME: join(home, ".codex"), GROK_HOME: join(home, ".grok"), XDG_CONFIG_HOME: join(home, ".config"),
  });
  const created = await page.evaluate(() => window.termina.createTerminal({ type: "shell", shell: "/bin/bash" }));
  expect(created.ok, created.error).toBe(true);
  const id = created.id!;
  const activity = () => page.evaluate(async (id) => (await window.termina.getInstances()).find((entry) => entry.id === id)?.activity, id);
  const summary = () => page.evaluate(async (id) => {
    const overview = await window.termina.getWorkOverview();
    const project = overview.projects.find((entry) => entry.terminals.some((terminal) => terminal.terminalId === id))!;
    return { terminal: project.terminals.find((entry) => entry.terminalId === id), working: project.working, attention: project.attentionCount };
  }, id);
  expect((await summary()).terminal?.activity).toBeNull();

  // Execute the commands actually installed by main. No provider credentials,
  // model calls, host configuration, or fabricated sidecar records are used.
  for (const cli of EXTERNAL_CLIS) {
    const emit = async (event: string) => {
      const command = await installedCommand(home, cli, event);
      const payload = cli === "gemini" ? { toolCall: { name: "run_command" }, stepIdx: 3 }
        : { hook_event_name: event, tool_name: "Bash", tool_use_id: `${cli}-call` };
      await page.evaluate(({ id, input }) => window.termina.writeTerminal(id, input), {
        id, input: `printf '%s' ${shellQuote(JSON.stringify(payload))} | ${command}\r`,
      });
    };
    await emit("PreToolUse");
    await expect.poll(activity, { message: `${cli} hook must reach the terminal` }).toMatchObject({ state: "working" });
    await expect.poll(summary, { message: `${cli} activity must reach the project overview` }).toMatchObject({
      terminal: { activity: { state: "working" }, verify: null, model: null }, working: 1, attention: 0,
    });
    await expect(page.locator(".project-tab .project-working").first()).toHaveText("1 working");
    if (cli === "codex" || cli === "claude" || cli === "muse") {
      await emit("PermissionRequest");
      await expect.poll(activity).toMatchObject({ state: "blocked", reason: "permission-required" });
      await expect.poll(summary).toMatchObject({ terminal: { activity: { state: "blocked" } }, working: 0, attention: 1 });
      await expect(page.locator(".project-tab .project-attention").first()).toHaveText("1 attention");
    }
    await emit("PostToolUse");
    await expect.poll(activity).toMatchObject({ state: "working", intervention: null });
    await emit("Stop");
    await expect.poll(activity).toMatchObject({ state: "idle", reason: "outcome-unknown" });
    await expect.poll(summary).toMatchObject({ terminal: { activity: { state: "idle", reason: "outcome-unknown" } }, working: 0, attention: 0 });
  }
});
