import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { patchBundleName } from "../../scripts/patch-bundle-name.ts";

export interface TerminaE2EFixtures {
  electronApp: ElectronApplication;
  page: Page;
  projectRoot: string;
  runRoot: string;
  terminalEngine: "pi" | "core";
  closeElectron: () => Promise<void>;
}

async function stopElectron(app: ElectronApplication): Promise<void> {
  const child = app.process();
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolveDone) => {
    const forceKill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* The exit listener still owns completion. */
      }
    }, 3_000);

    child.once("exit", () => {
      clearTimeout(forceKill);
      resolveDone();
    });

    app.close().catch(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* The exit listener still owns completion. */
      }
    });
  });
}

export const test = base.extend<TerminaE2EFixtures>({
  terminalEngine: ["pi", { option: true }],
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

  electronApp: async ({ runRoot, projectRoot, terminalEngine }, use) => {
    const eventsDir = join(runRoot, "events");
    const worldsDir = join(runRoot, "worlds");
    const userData = join(runRoot, "user-data");
    const homeDir = join(runRoot, "home");
    mkdirSync(userData, { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    // Seed the requested agent engine so term-1 has active sidecar tailing.
    const canonicalProjectRoot = realpathSync(projectRoot);
    const slug = `--${canonicalProjectRoot.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "").replace(/[/\\:]/g, "-")}--`;
    const rosterDir = join(userData, "terminal-rosters");
    mkdirSync(rosterDir, { recursive: true });
    writeFileSync(
      join(rosterDir, `${slug}.json`),
      JSON.stringify({ terminals: [{ id: "term-1", type: "agent", engine: terminalEngine }] }) + "\n",
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
    delete env.ELECTRON_RUN_AS_NODE;

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
    await stopElectron(app);
  },

  closeElectron: async ({ electronApp }, use) => {
    await use(() => stopElectron(electronApp));
  },

  page: async ({ electronApp }, use) => {
    let page = electronApp.windows()[0];
    if (!page) {
      try {
        page = await electronApp.firstWindow({ timeout: 30_000 });
      } catch {
        page = electronApp.windows()[0];
      }
    }
    if (!page) {
      throw new Error("Electron window was not created within deadline");
    }
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  },
});

export { expect };
