import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { patchBundleName } from "../../scripts/patch-bundle-name.mjs";

export interface TerminaE2EFixtures {
  electronApp: ElectronApplication;
  page: Page;
  projectRoot: string;
  runRoot: string;
}

export const test = base.extend<TerminaE2EFixtures>({
  runRoot: async ({}, use) => {
    const runRoot = mkdtempSync(join(tmpdir(), "termina-playwright-"));
    await use(runRoot);
    try {
      rmSync(runRoot, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  },

  projectRoot: async ({ runRoot }, use) => {
    const root = join(runRoot, "test-project");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "greeting.ts"), 'export const greeting = "hello";\n');
    writeFileSync(join(root, "hello.txt"), "hello\n");
    writeFileSync(join(root, "src", "index.ts"), "export const index = true;\n");

    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      execFileSync("git", ["config", "user.email", "dev@termina.local"], { cwd: root });
      execFileSync("git", ["config", "user.name", "termina"], { cwd: root });
      execFileSync("git", ["add", "-A"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
    } catch {
      /* fallback if git is unavailable */
    }

    await use(root);
  },

  electronApp: async ({ runRoot, projectRoot }, use) => {
    const eventsDir = join(runRoot, "events");
    const worldsDir = join(runRoot, "worlds");
    const userData = join(runRoot, "user-data");
    const homeDir = join(runRoot, "home");
    mkdirSync(userData, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    // Seed Pi agent roster so term-1 is an agent terminal with active sidecar tailing
    const slug = `--${projectRoot.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "").replace(/[/\\:]/g, "-")}--`;
    const rosterDir = join(userData, "terminal-rosters");
    mkdirSync(rosterDir, { recursive: true });
    writeFileSync(
      join(rosterDir, `${slug}.json`),
      JSON.stringify({ terminals: [{ id: "term-1", type: "agent", engine: "pi" }] }) + "\n",
    );

    patchBundleName();

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      HOME: homeDir,
      USERPROFILE: homeDir,
      TERMINA_INITIAL_CWD: projectRoot,
      TERMINA_EVENTS_DIR: eventsDir,
      TERMINA_WORLDS_DIR: worldsDir,
      TERMINA_USER_DATA_DIR: userData,
      TERMINA_E2E_RUN_ROOT: runRoot,
      NODE_ENV: "test",
    };

    const app = await electron.launch({
      args: [
        resolve("."),
        `--user-data-dir=${userData}`,
      ],
      env,
    });

    app.process().stderr?.on("data", (chunk) => {
      const msg = chunk.toString();
      if (!msg.includes("GPU") && !msg.includes("libpng") && !msg.includes("fontconfig")) {
        console.error("[electron:err]", msg.trim());
      }
    });

    await use(app);

    await new Promise<void>((resolve) => {
      const child = app.process();
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 3_000);

      child.once("exit", () => {
        clearTimeout(timer);
        setTimeout(resolve, 300);
      });

      app.close().catch(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      });
    });
  },

  page: async ({ electronApp }, use) => {
    let page = electronApp.windows()[0];
    if (!page) {
      const deadline = Date.now() + 10_000;
      while (!page && Date.now() < deadline) {
        page = electronApp.windows()[0];
        if (page) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!page) {
      page = await electronApp.firstWindow({ timeout: 15_000 });
    }
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  },
});

export { expect };
