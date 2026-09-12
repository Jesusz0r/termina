import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { patchBundleName } from "../../scripts/patch-bundle-name.ts";
import { OwnedProcessTree } from "./owned-processes.ts";

export interface TerminaE2EFixtures {
  electronApp: ElectronApplication;
  page: Page;
  projectRoot: string;
  runRoot: string;
  terminalEngine: "core";
  closeElectron: () => Promise<void>;
}

// Capture process handles while the Playwright connection is alive. Early
// close and fixture teardown share one completion, including orphan cleanup.
const electronLifetimes = new WeakMap<ElectronApplication, {
  child: ReturnType<ElectronApplication["process"]>;
  tree: OwnedProcessTree;
  shutdown: Promise<void> | null;
  /** Bounded tail of the app's output, so a failed startup is diagnosable.
   *  stdout and stderr are both kept: `[main]` startup logs go to stdout, while
   *  Chromium/GPU failures land on stderr, and either can be empty. */
  outputTail: string[];
}>();
const preservedRunRoots = new Set<string>();

/**
 * Total budget for the app to surface its first window. Startup is normally
 * about a second, but a loaded machine has been observed to delay the renderer
 * far past that, so the budget is generous and the failure carries diagnostics.
 */
const WINDOW_DEADLINE_MS = 60_000;
const WINDOW_POLL_MS = 5_000;
const OUTPUT_TAIL_LINES = 40;

function stopElectron(app: ElectronApplication): Promise<void> {
  const lifetime = electronLifetimes.get(app);
  if (!lifetime) return Promise.reject(new Error("missing test Electron ownership"));
  if (lifetime.shutdown) return lifetime.shutdown;
  const { child, tree } = lifetime;
  lifetime.shutdown = (async () => {
    let captureError: unknown = null;
    const forceKill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { tree.capture(); } catch (error) { captureError = error; }
      child.kill("SIGKILL");
    };
    await new Promise<void>((resolveDone) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveDone();
        return;
      }
      const timer = setTimeout(forceKill, 3_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveDone();
      });
      app.close().catch(forceKill);
    });
    await tree.stop();
    if (captureError) throw captureError;
  })();
  return lifetime.shutdown;
}

/** Append to a bounded output tail, dropping the oldest lines first. */
function rememberOutput(tail: string[], chunk: string): void {
  for (const line of chunk.split("\n")) {
    if (line.trim()) tail.push(line);
  }
  if (tail.length > OUTPUT_TAIL_LINES) tail.splice(0, tail.length - OUTPUT_TAIL_LINES);
}

/**
 * Acquire the app's first window.
 *
 * `windows()` catches a window that appeared before this ran, while
 * `firstWindow()` waits for one that has not. Both are polled until the shared
 * deadline, because a single `firstWindow()` call can race an already-created
 * window and a single `windows()` read can miss one still loading.
 *
 * On failure the app's output tail is included: without it the only symptom is
 * a bare deadline message and the cause (a failed GPU context, a crash, a stuck
 * startup) is invisible.
 */
async function acquireFirstWindow(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + WINDOW_DEADLINE_MS;
  let lastError: unknown = null;
  for (;;) {
    const existing = app.windows()[0];
    if (existing) return existing;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await app.firstWindow({ timeout: Math.min(WINDOW_POLL_MS, remaining) });
    } catch (error) {
      lastError = error;
    }
  }
  const late = app.windows()[0];
  if (late) return late;
  const tail = (electronLifetimes.get(app)?.outputTail ?? []).slice(-20);
  throw new Error(
    `Electron window was not created within ${WINDOW_DEADLINE_MS}ms`
    + (lastError ? `\nlast wait error: ${String(lastError)}` : "")
    + (tail.length ? `\n--- app output (last ${tail.length} lines) ---\n${tail.join("\n")}` : "\napp produced no output"),
  );
}

export const test = base.extend<TerminaE2EFixtures>({
  terminalEngine: ["core", { option: true }],
  runRoot: async ({}, use) => {
    const runRoot = mkdtempSync(join(tmpdir(), "termina-playwright-"));
    await use(runRoot);
    if (preservedRunRoots.has(runRoot)) {
      console.warn(`[e2e] retaining ${runRoot}: process cleanup was not confirmed`);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        rmSync(runRoot, { recursive: true, force: true });
        break;
      } catch {
        if (attempt === 3) break;
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
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
      execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, stdio: "ignore" });
    } catch (err) {
      throw new Error(`e2e fixture requires git: ${(err as Error).message}`);
    }

    await use(root);
  },

  electronApp: async ({ runRoot, projectRoot, terminalEngine }, use) => {
    const eventsDir = join(runRoot, "events");
    const worldsDir = join(runRoot, "worlds");
    const userData = join(runRoot, "user-data");
    const homeDir = join(runRoot, "home");
    // SidecarTailer.armWatch fails closed while this directory is missing.
    // Create it before launch so boot session_ready is visible to the tailer.
    mkdirSync(eventsDir, { recursive: true });
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
      // Keep the window off screen and out of the Dock: the suite drives the
      // real app, and a shown window would hold the user's focus for the run.
      TERMINA_E2E_HIDDEN: "1",
    };
    delete env.ELECTRON_RUN_AS_NODE;

    preservedRunRoots.add(runRoot);
    const app = await electron.launch({
      args: [
        resolve("."),
        `--user-data-dir=${userData}`,
        // Deterministic software rendering: without this the GPU mode varies
        // with the host. Production keeps the GPU; the suite never needs
        // WebGL (guarded by gpu-mode.spec.ts).
        "--disable-gpu",
      ],
      env,
    });

    const child = app.process();
    const lifetime = { child, tree: new OwnedProcessTree(child.pid!), shutdown: null, outputTail: [] as string[] };
    electronLifetimes.set(app, lifetime);
    // Suppressed-noise counters, split by class: the filter below keeps the
    // console readable, but a silent filter also hides frequency regressions,
    // so every suppressed line is counted and reported once per test below.
    let suppressedGpu = 0;
    let suppressedLib = 0;
    // Buffer both streams for diagnostics; stdout carries `[main]` startup logs
    // while stderr carries Chromium/GPU failures, and either can be empty when
    // the window never appears.
    child.stderr?.on("data", (chunk) => {
      const msg = chunk.toString();
      rememberOutput(lifetime.outputTail, msg);
      // The GLES context failure spells it lowercase ("gpu/ipc/..."), so the
      // match must be case-insensitive to actually cover it.
      if (!/gpu|libpng|fontconfig/i.test(msg)) {
        console.error("[electron:err]", msg.trim());
      } else if (/gpu/i.test(msg)) {
        suppressedGpu++;
      } else {
        suppressedLib++;
      }
    });
    child.stdout?.on("data", (chunk) => rememberOutput(lifetime.outputTail, chunk.toString()));

    try {
      await use(app);
    } finally {
      await stopElectron(app);
      const parts: string[] = [];
      if (suppressedGpu > 0) parts.push(`${suppressedGpu} gpu`);
      if (suppressedLib > 0) parts.push(`${suppressedLib} libpng/fontconfig`);
      if (parts.length > 0) console.error(`[electron:err] suppressed ${parts.join(" + ")} stderr line(s)`);
      preservedRunRoots.delete(runRoot);
    }
  },

  closeElectron: async ({ electronApp }, use) => {
    await use(() => stopElectron(electronApp));
  },

  page: async ({ electronApp }, use) => {
    const page = await acquireFirstWindow(electronApp);
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  },
});

export { expect };
