import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for global effort persistence: /effort choices are
 * remembered in app preferences (except worldline candidates, which run
 * explicit specs), fresh core terminals boot with TERMINA_CORE_EFFORT, and
 * agent-core seeds its wanted level from that env pin.
 */
describe("Effort Persistence Invariants", () => {
  const main = readFileSync("electron/main.ts", "utf8");
  const core = readFileSync("agent-core/main.ts", "utf8");

  it("remembers sidecar-reported effort, skipping candidate terminals", () => {
    assert.match(main, /this\.rememberEffort\(inst, nextThinking\)/);
    assert.match(main, /if \(this\.worldlineTailers\.has\(inst\.id\)\) return;/s);
    assert.match(main, /commitPreferencePatch\(\{ defaultEffort: level \}/);
  });

  it("pins TERMINA_CORE_EFFORT on fresh core spawns, never leaking host env", () => {
    assert.match(main, /if \(defaultEffort\) env\.TERMINA_CORE_EFFORT = defaultEffort;/);
    assert.match(main, /else delete env\.TERMINA_CORE_EFFORT;/);
  });

  it("seeds the core wanted level from the env pin, defaulting to medium", () => {
    assert.match(core, /process\.env\.TERMINA_CORE_EFFORT/);
  });
});
