import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, closeOwnedElectron, launchOwnedElectron } from "./fixtures.ts";

// Stand-in Codex: logs its argv, then runs the hook command Termina installed
// in hooks.json with a SessionStart payload, as Codex does at launch.
// The login-shell PATH of the test HOME has no node: pin this runner's.
const FAKE_CODEX = `#!${process.execPath}
const fs = require("node:fs");
const { execSync } = require("node:child_process");
fs.appendFileSync(process.env.TERMINA_TEST_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const hooks = JSON.parse(fs.readFileSync(process.env.CODEX_HOME + "/hooks.json", "utf8")).hooks.SessionStart;
const command = hooks[hooks.length - 1].hooks[0].command;
const id = process.argv[2] === "resume" ? process.argv[3] : "0199a2b4-resume-me";
execSync(command, { input: JSON.stringify({ hook_event_name: "SessionStart", session_id: id, cwd: process.cwd(), source: "startup" }) });
setInterval(() => {}, 1000);
`;

test("a restored Codex tab resumes the conversation its hooks reported", async ({ page, electronApp, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const bin = join(runRoot, "cli-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), FAKE_CODEX, { mode: 0o700 });
  const argvLog = join(runRoot, "codex-argv.log");
  await electronApp.evaluate((_, { bin, argvLog }) => {
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.CODEX_HOME = `${process.env.HOME}/.codex`;
    process.env.TERMINA_TEST_ARGV_LOG = argvLog;
  }, { bin, argvLog });
  const created = await page.evaluate(() => window.termina.createTerminal({ cli: "codex" }));
  expect(created.ok, created.error).toBe(true);
  const rosterDir = join(runRoot, "user-data", "terminal-rosters");
  const savedSession = () => {
    try {
      const files = readdirSync(rosterDir).filter((name: string) => name.endsWith(".json"));
      return files.flatMap((name: string) => JSON.parse(readFileSync(join(rosterDir, name), "utf8")).terminals)
        .find((entry: { cli?: string }) => entry.cli === "codex")?.cliSession ?? null;
    } catch {
      return null;
    }
  };
  await expect.poll(savedSession).toBe("0199a2b4-resume-me");
  const environment = await electronApp.evaluate(() => ({ ...process.env }));
  const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.TERMINA_INITIAL_CWD;
  await closeOwnedElectron(electronApp);
  const replacement = await launchOwnedElectron(env, runRoot);
  try {
    await replacement.firstWindow();
    await expect.poll(() => readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)))
      .toEqual([[], ["resume", "0199a2b4-resume-me"]]);
  } finally {
    await closeOwnedElectron(replacement);
  }
});

// Stand-in agy: logs its argv, then runs the PreInvocation hook Termina
// installed in ~/.gemini/config/hooks.json with agy's camelCase payload.
const FAKE_AGY = `#!${process.execPath}
const fs = require("node:fs");
const { execSync } = require("node:child_process");
fs.appendFileSync(process.env.TERMINA_TEST_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const hooks = JSON.parse(fs.readFileSync(process.env.HOME + "/.gemini/config/hooks.json", "utf8"))["termina-observe"];
const id = process.argv[2] === "--conversation" ? process.argv[3] : "016171fe-3403-4f5c-b500-9ea33b3d9226";
execSync(hooks.PreInvocation[0].command, { input: JSON.stringify({ conversationId: id, invocationNum: 0, workspacePaths: [process.cwd()] }) });
setInterval(() => {}, 1000);
`;

test("a restored Gemini (agy) tab resumes the conversation its hooks reported", async ({ page, electronApp, runRoot }) => {
  await expect(page.locator("#splash")).toBeHidden();
  const bin = join(runRoot, "cli-bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "agy"), FAKE_AGY, { mode: 0o700 });
  const argvLog = join(runRoot, "agy-argv.log");
  await electronApp.evaluate((_, { bin, argvLog }) => {
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.TERMINA_TEST_ARGV_LOG = argvLog;
  }, { bin, argvLog });
  const created = await page.evaluate(() => window.termina.createTerminal({ cli: "gemini" }));
  expect(created.ok, created.error).toBe(true);
  const rosterDir = join(runRoot, "user-data", "terminal-rosters");
  const savedSession = () => {
    try {
      const files = readdirSync(rosterDir).filter((name: string) => name.endsWith(".json"));
      return files.flatMap((name: string) => JSON.parse(readFileSync(join(rosterDir, name), "utf8")).terminals)
        .find((entry: { cli?: string }) => entry.cli === "gemini")?.cliSession ?? null;
    } catch {
      return null;
    }
  };
  await expect.poll(savedSession).toBe("016171fe-3403-4f5c-b500-9ea33b3d9226");
  const environment = await electronApp.evaluate(() => ({ ...process.env }));
  const env = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  delete env.TERMINA_INITIAL_CWD;
  await closeOwnedElectron(electronApp);
  const replacement = await launchOwnedElectron(env, runRoot);
  try {
    await replacement.firstWindow();
    await expect.poll(() => readFileSync(argvLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)))
      .toEqual([[], ["--conversation", "016171fe-3403-4f5c-b500-9ea33b3d9226"]]);
  } finally {
    await closeOwnedElectron(replacement);
  }
});
