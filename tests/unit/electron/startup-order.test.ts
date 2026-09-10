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
      preferencesStore: { load: async () => ({ shortcuts: {} }) },
      registerIpc: () => {},
      prepareEventsDir: async () => {},
      cleanupStaleDispatchFiles: async () => {},
      parseTargetCwdFromArgv: () => null,
      tailer: { onEvent: null, start: () => {} },
      startScheduleTick: () => {},
      createWindow: () => {
        windowShown.resolve();
        return windowLoaded.promise;
      },
      restoreInitialProjects: vi.fn(() => projectsRestored.promise),
    };

    const started = start.call(app);
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
