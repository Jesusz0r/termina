import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { readSystemProcessIdentity } from "../../shared/process-identity.ts";
import { join, resolve } from "node:path";
import { patchBundleName } from "../../scripts/patch-bundle-name.ts";
import { OwnedProcessTree } from "./owned-processes.ts";
import { e2eTempDir } from "./tmpdir.ts";

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
  processIdentity: string | null;
  closed: Promise<void>;
  nativeError: string | null;
  startupSample: string | null;
  runRoot: string;
}>();
const activeElectrons = new Map<string, Set<ElectronApplication>>();
const preservedRunRoots = new Set<string>();

/**
 * Total budget for the app to surface its first window. Startup is normally
 * about a second, but a loaded machine has been observed to delay the renderer
 * far past that, so the budget is generous and the failure carries diagnostics.
 */
const WINDOW_DEADLINE_MS = 60_000;
const WINDOW_POLL_MS = 5_000;
const OUTPUT_TAIL_LINES = 40;

export function sampleOwnedProcessMemory(app: ElectronApplication): ReturnType<OwnedProcessTree["sampleMemory"]> {
  const lifetime = electronLifetimes.get(app);
  if (!lifetime) throw new Error("missing test Electron ownership");
  return lifetime.tree.sampleMemory();
}

export function closeOwnedElectron(app: ElectronApplication): Promise<void> {
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
    await lifetime.closed;
    if (captureError) throw captureError;
    const active = activeElectrons.get(lifetime.runRoot);
    active?.delete(app);
    if (active?.size === 0) {
      activeElectrons.delete(lifetime.runRoot);
      preservedRunRoots.delete(lifetime.runRoot);
    }
    if (lifetime.nativeError) throw new Error(`Owned Electron failed during native teardown: ${lifetime.nativeError}`);
  })();
  return lifetime.shutdown;
}

/** Append to a bounded output tail, dropping the oldest lines first. */
function rememberOutput(tail: string[], chunk: string): void {
  for (const line of chunk.split("\n")) {
    if (line.trim()) tail.push(`${new Date().toISOString()} ${line}`);
  }
  if (tail.length > OUTPUT_TAIL_LINES) tail.splice(0, tail.length - OUTPUT_TAIL_LINES);
}

/** Sample only this fixture's still-live process before startup cleanup. */
async function captureStartupSample(app: ElectronApplication): Promise<void> {
  const lifetime = electronLifetimes.get(app);
  if (!lifetime || process.platform !== "darwin") return;
  const { child, processIdentity, runRoot } = lifetime;
  if (!processIdentity || child.exitCode !== null || child.signalCode !== null
    || readSystemProcessIdentity(child.pid!) !== processIdentity) {
    lifetime.startupSample = "Native sample unavailable: the launched process is no longer identity-validated.";
    return;
  }
  const path = join(runRoot, `electron-startup-${child.pid}.sample.txt`);
  try {
    await new Promise<void>((resolveDone, reject) => {
      execFile("/usr/bin/sample", [String(child.pid), "3", "10", "-file", path], {
        timeout: 8_000, maxBuffer: 512 * 1024,
      }, (error) => error ? reject(error) : resolveDone());
    });
    lifetime.startupSample = (await readFile(path, "utf8")).slice(0, 512 * 1024);
  } catch (error) {
    lifetime.startupSample = `Native sample unavailable: ${String(error)}`;
  }
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
  let startupState: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    startupState = await Promise.race([
      app.evaluate(({ app, BrowserWindow }) => ({
        ready: app.isReady(),
        hasLock: app.hasSingleInstanceLock(),
        appPath: app.getAppPath(),
        userData: app.getPath("userData"),
        pid: process.pid,
        windows: BrowserWindow.getAllWindows().map((win) => ({ id: win.id, destroyed: win.isDestroyed() })),
      })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("startup probe timed out")), 5_000); }),
    ]);
  } catch (error) {
    startupState = { probeError: String(error), exitCode: app.process().exitCode };
  } finally {
    if (timer) clearTimeout(timer);
  }
  await captureStartupSample(app);
  throw new Error(
    `Electron window was not created within ${WINDOW_DEADLINE_MS}ms`
    + `\nstartup state: ${JSON.stringify(startupState)}`
    + (lastError ? `\nlast wait error: ${String(lastError)}` : "")
    + (tail.length ? `\n--- app output (last ${tail.length} lines) ---\n${tail.join("\n")}` : "\napp produced no output"),
  );
}

/** Launch or sequentially restart an Electron using the same isolated roots. */
export async function launchOwnedElectron(env: Record<string, string>, runRoot: string): Promise<ElectronApplication> {
  preservedRunRoots.add(runRoot);
  const app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${env.TERMINA_USER_DATA_DIR}`, "--disable-gpu",
      // AppKit persistence is bundle-scoped, not Electron-user-data-scoped.
      // Ignore that external saved state without changing host preferences.
      ...(process.platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : []),
    ], env,
  });
  const child = app.process();
  const lifetime = {
    child, tree: new OwnedProcessTree(child.pid!), shutdown: null, outputTail: [] as string[], runRoot,
    processIdentity: readSystemProcessIdentity(child.pid!),
    closed: new Promise<void>((resolveDone) => child.once("close", () => resolveDone())),
    nativeError: null as string | null,
    startupSample: null as string | null,
  };
  electronLifetimes.set(app, lifetime);
  const active = activeElectrons.get(runRoot) ?? new Set<ElectronApplication>();
  active.add(app);
  activeElectrons.set(runRoot, active);
  const recordOutput = (chunk: Buffer): void => {
    rememberOutput(lifetime.outputTail, chunk.toString());
    const nativeError = lifetime.outputTail.find((line) => /Napi::Error|terminating due to uncaught exception|terminate called after throwing/.test(line));
    if (nativeError) lifetime.nativeError ??= nativeError;
  };
  child.stderr?.on("data", recordOutput);
  child.stdout?.on("data", recordOutput);
  const crashDumpDir = join(runRoot, "crash-dumps", String(child.pid));
  mkdirSync(crashDumpDir, { recursive: true });
  try {
    await app.evaluate(({ app, crashReporter }, path) => {
      app.setPath("crashDumps", path);
      crashReporter.start({ uploadToServer: false, ignoreSystemCrashHandler: true });
    }, crashDumpDir);
  } catch (error) {
    await closeOwnedElectron(app);
    throw error;
  }
  return app;
}

export const test = base.extend<TerminaE2EFixtures>({
  terminalEngine: ["core", { option: true }],
  runRoot: async ({}, use) => {
    const runRoot = mkdtempSync(join(e2eTempDir(), "termina-playwright-"));
    await use(runRoot);
    // A restarted app still belongs to this fixture if the test exits early.
    for (const app of [...(activeElectrons.get(runRoot) ?? [])]) {
      try {
        await closeOwnedElectron(app);
      } catch (error) {
        console.warn(`[e2e] could not stop an owned Electron: ${String(error)}`);
      }
    }
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

  electronApp: async ({ runRoot, projectRoot, terminalEngine }, use, testInfo) => {
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

    // Software rendering keeps startup deterministic without a host GPU.
    const app = await launchOwnedElectron(env, runRoot);
    const child = app.process();
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
    try {
      await use(app);
    } finally {
      try {
        await closeOwnedElectron(app);
      } finally {
        const lifetime = electronLifetimes.get(app);
        if (testInfo.status !== testInfo.expectedStatus || lifetime?.nativeError || lifetime?.startupSample) {
          try {
            await testInfo.attach("electron-output-tail", { body: (lifetime?.outputTail ?? []).join("\n"), contentType: "text/plain" });
            if (lifetime?.startupSample) {
              await testInfo.attach("electron-startup-native-sample", { body: lifetime.startupSample, contentType: "text/plain" });
            }
            if (lifetime?.nativeError) {
              const crashDumpDir = join(lifetime.runRoot, "crash-dumps", String(lifetime.child.pid));
              const dumps = (await readdir(crashDumpDir, { recursive: true })).filter((path) => path.endsWith(".dmp")).slice(0, 10);
              for (const dump of dumps) {
                await testInfo.attach(`owned-electron-${dump.replaceAll("/", "-")}`, { path: join(crashDumpDir, dump), contentType: "application/octet-stream" });
              }
            }
          } catch (error) {
            console.warn(`[e2e] could not attach owned Electron output: ${String(error)}`);
          }
        }
        const parts: string[] = [];
        if (suppressedGpu > 0) parts.push(`${suppressedGpu} gpu`);
        if (suppressedLib > 0) parts.push(`${suppressedLib} libpng/fontconfig`);
        if (parts.length > 0) console.error(`[electron:err] suppressed ${parts.join(" + ")} stderr line(s)`);
      }
    }
  },

  closeElectron: async ({ electronApp }, use) => {
    await use(() => closeOwnedElectron(electronApp));
  },

  page: async ({ electronApp }, use) => {
    const page = await acquireFirstWindow(electronApp);
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  },
});

export { expect };
