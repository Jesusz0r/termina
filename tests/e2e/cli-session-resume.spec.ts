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
