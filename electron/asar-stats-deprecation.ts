/**
 * Electron's asar filesystem shim builds stats with `new fs.Stats()`.
 * Node reports that as DEP0180. The replacement is in Electron 45
 * (electron/electron#52833) and is not backported to the 37 line this
 * app runs. Swallow only that warning until the app is on Electron 45
 * or newer.
 */
const INSTALLED = Symbol.for("termina.silenceAsarStatsDeprecation");

type WarningListener = (warning: Error) => void;

function isAsarStatsDeprecation(warning: unknown): boolean {
  return typeof warning === "object"
    && warning !== null
    && "code" in warning
    && (warning as { code?: unknown }).code === "DEP0180";
}

export function silenceAsarStatsDeprecation(): void {
  const proc = process as NodeJS.Process & { [INSTALLED]?: boolean };
  if (proc[INSTALLED]) return;
  proc[INSTALLED] = true;
  const listeners = process.listeners("warning") as WarningListener[];
  if (listeners.length === 0) return;
  process.removeAllListeners("warning");
  for (const listener of listeners) {
    process.on("warning", (warning: Error) => {
      if (isAsarStatsDeprecation(warning)) return;
      listener(warning);
    });
  }
}

// ESM hoists imports, so a call in main.ts would run after every imported
// module's top level. Installing here runs as soon as main.ts imports it.
silenceAsarStatsDeprecation();
