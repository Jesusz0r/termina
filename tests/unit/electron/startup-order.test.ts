import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Execute the production start method, without importing Electron's entrypoint
// or starting real processes. Only its I/O boundaries are replaced.
const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
const method = main.match(/  async start\(\): Promise<void> \{[\s\S]*?\n  \}/)?.[0];
if (!method) throw new Error("main startup method not found");
const code = ts.transpileModule(`return ({ ${method} }).start;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

describe("initial project restoration", () => {
  it.each([false, true])("gates renderer hydration without delaying the window for restoration (hidden=%s)", async (hiddenWindow) => {
    const windowShown = deferred();
    const windowLoaded = deferred();
    const projectsRestored = deferred();
    const updater = { start: vi.fn() };
    const hideDock = vi.fn();
    const start = new Function("mkdir", "createAppUpdater", "detectShells", "process", "existsSync", "pendingOpenPath", "E2E_HIDDEN_WINDOW", "app", code)(
      async () => {},
      () => updater,
      () => {},
      { argv: [], env: { TERMINA_INITIAL_CWD: "/fixture/project" } },
      () => true,
      null,
      hiddenWindow,
      { dock: { hide: hideDock } },
    );
    const app = {
      initialRestorePromise: null as Promise<void> | null,
      coreSessionRoot: () => "/fixture/core",
      worldsRoot: "/fixture/worlds",
      canonicalPath: async (path: string) => path,
      preferencesStore: { load: async () => ({ shortcuts: {} }) },
      registerIpc: () => {},
      registerMediaProtocol: () => {},
      startLoginHintWatch: () => {},
      prepareEventsDir: async () => {},
      cleanupStaleDispatchFiles: async () => {},
      parseTargetCwdFromArgv: () => null,
      tailer: { onEvent: null, start: () => {} },
      bindSidecarHold: () => {},
      schedules: { start: () => {} },
      createWindow: () => {
        windowShown.resolve();
        return windowLoaded.promise;
      },
      restoreInitialProjects: vi.fn(() => projectsRestored.promise),
    };

    const started = start.call(app);
    // open-file / second-instance can land during boot I/O: the barrier
    // exists before start() first yields.
    expect(app.initialRestorePromise).toBeInstanceOf(Promise);
    try {
      await windowShown.promise;
      // project:list / terminals:list must already have a barrier to await
      // when the renderer boots during loadFile, not an empty early snapshot.
      expect(app.initialRestorePromise).toBeInstanceOf(Promise);
      expect(app.restoreInitialProjects).not.toHaveBeenCalled();
      let hydrated = false;
      void app.initialRestorePromise!.then(() => { hydrated = true; });

      windowLoaded.resolve();
      await started;
      expect(updater.start).toHaveBeenCalledOnce();
      expect(hideDock).toHaveBeenCalledTimes(hiddenWindow ? 1 : 0);
      expect(app.restoreInitialProjects).toHaveBeenCalledWith("/fixture/project", null);
      expect(hydrated).toBe(false);

      projectsRestored.resolve();
      await app.initialRestorePromise;
      expect(hydrated).toBe(true);
    } finally {
      windowLoaded.resolve();
      projectsRestored.resolve();
      await started;
      await app.initialRestorePromise;
    }
  });
});

describe("failed boot", () => {
  it("settles the restoration barrier so quit and gated IPC do not wait forever", async () => {
    const start = new Function("mkdir", "createAppUpdater", "detectShells", "process", "existsSync", "pendingOpenPath", "E2E_HIDDEN_WINDOW", "app", code)(
      async () => { throw new Error("EACCES"); },
      () => ({ start: () => {} }),
      () => {},
      { argv: [], env: {} },
      () => false,
      null,
      true,
      { dock: { hide: () => {} } },
    );
    const app = { initialRestorePromise: null as Promise<void> | null, coreSessionRoot: () => "/fixture/core" };
    await expect(start.call(app)).rejects.toThrow("EACCES");
    await expect(app.initialRestorePromise).resolves.toBeUndefined();
  });
});

const restoreMethod = main.match(/  private async restoreInitialProjects\([\s\S]*?\n  \}/)?.[0];
if (!restoreMethod) throw new Error("initial restore method not found");
const restoreCode = ts.transpileModule(`return ({ ${restoreMethod.replace("private async", "async")} }).restoreInitialProjects;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

describe("initial restoration barrier", () => {
  function harness(env: Record<string, string>, fail: (root: string) => boolean, canonicalFails = false) {
    const restore = new Function("process", "stat", restoreCode)(
      { env },
      async () => ({ isDirectory: () => true }),
    );
    const opened: string[] = [];
    const app = {
      preferences: { openProjects: ["/stored/a"], activeProject: null },
      projects: new Map(),
      activeProjectId: null,
      canonicalPath: async (path: string) => {
        if (canonicalFails) throw new Error("ENOENT");
        return path;
      },
      openProject: vi.fn(async (root: string) => {
        if (fail(root)) throw new Error("journal is unreadable");
        opened.push(root);
      }),
      activateProject: vi.fn(),
      sendInstances: vi.fn(),
    };
    return { app, opened, run: (cwd: string, cli: string | null) => restore.call(app, cwd, cli) as Promise<void> };
  }

  it("resolves when the fixture project cannot open", async () => {
    const { app, run } = harness({ TERMINA_INITIAL_CWD: "/broken" }, () => true);
    await expect(run("/broken", null)).resolves.toBeUndefined();
    expect(app.sendInstances).toHaveBeenCalledOnce();
  });

  it("resolves and keeps stored projects when the CLI target cannot open", async () => {
    const { app, opened, run } = harness({}, (root) => root === "/broken");
    await expect(run("/broken", "/broken")).resolves.toBeUndefined();
    expect(opened).toEqual(["/stored/a"]);
    expect(app.sendInstances).toHaveBeenCalledOnce();
  });

  it("resolves when the CLI target disappears before canonicalization", async () => {
    const { app, run } = harness({}, () => false, true);
    await expect(run("/gone", "/gone")).resolves.toBeUndefined();
    expect(app.sendInstances).toHaveBeenCalledOnce();
  });
});

const openMethod = main.match(/  private async openProject\([\s\S]*?\n  \}/)?.[0];
if (!openMethod) throw new Error("project open method not found");
const openCode = ts.transpileModule(`return ({ ${openMethod.replace("private async", "async")} }).openProject;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

describe("project open", () => {
  it("leaves no registered or active project when promotion recovery refuses the root", async () => {
    const openProject = new Function("nextProjectId", "lstat", "recoverPromotionJournals", openCode)(
      () => "p-new",
      async () => ({ isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n }),
      async () => { throw new Error("promotion journal root is unproven"); },
    );
    const app = {
      projects: new Map([["p-old", { id: "p-old" }]]),
      switchingProjects: new Set<string>(),
      activeProjectId: "p-old",
      projectSelectionAction: 1,
      projectActivationGeneration: 4,
      worldsRoot: "/worlds",
      beginProjectSelectionAction: () => 1,
      captureRendererSendTarget: () => null,
      canonicalPath: async (path: string) => path,
      nextProjectActivationGeneration: vi.fn(() => 5),
      createWorkspace: vi.fn(),
      persistOpenProjects: vi.fn(),
    };
    await expect(openProject.call(app, "/project")).rejects.toThrow("unproven");
    expect([...app.projects.keys()]).toEqual(["p-old"]);
    expect(app.activeProjectId).toBe("p-old");
    expect(app.nextProjectActivationGeneration).not.toHaveBeenCalled();
    expect(app.createWorkspace).not.toHaveBeenCalled();
    expect(app.switchingProjects.size).toBe(0);
  });
});
