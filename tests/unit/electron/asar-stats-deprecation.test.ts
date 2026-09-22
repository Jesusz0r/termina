import { afterEach, describe, expect, it } from "vitest";
import { silenceAsarStatsDeprecation } from "../../../electron/asar-stats-deprecation.ts";

const INSTALLED = Symbol.for("termina.silenceAsarStatsDeprecation");

describe("asar stats deprecation", () => {
  const original = process.listeners("warning");

  afterEach(() => {
    process.removeAllListeners("warning");
    for (const listener of original) process.on("warning", listener);
    delete (process as NodeJS.Process & { [INSTALLED]?: boolean })[INSTALLED];
  });

  it("drops DEP0180 and still reports other warnings", async () => {
    const seen: string[] = [];
    process.on("warning", (warning: Error & { code?: string }) => {
      seen.push(warning.code ?? warning.name);
    });
    // Importing the module already installed it; reinstall over this listener.
    delete (process as NodeJS.Process & { [INSTALLED]?: boolean })[INSTALLED];
    silenceAsarStatsDeprecation();
    process.emitWarning("fs.Stats constructor is deprecated.", "DeprecationWarning", "DEP0180");
    process.emitWarning("still visible", "Warning", "TESTWARN");
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(["TESTWARN"]);
  });
});
