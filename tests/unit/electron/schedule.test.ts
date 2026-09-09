import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for background scheduling: due `@every` / `@at` plan
 * tasks dispatch through the normal worker path, idle owners only, with
 * dead-entry pruning and lifecycle-bounded timers. Pure marker math lives in
 * plan-board.test.ts; this probe covers the main-side wiring.
 */
describe("Schedule Tick Invariants", () => {
  it("ticks due schedules through dispatch with idle-only guards", async () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    // Only pending scheduled tasks participate.
    check("tick scans pending scheduled tasks",
      main.includes("if (task.state !== \"pending\") continue;")
      && main.includes("const spec = parseScheduleMarker(task.text);"));
    // Reschedule before dispatch so slow workers never pile up ticks.
    check("reschedule precedes dispatch",
      /this\.scheduledNextRuns\.set\(key, nextScheduleRun\(spec, now, false\)\);\n\s+if \(inst\.busy\) continue;/.test(main));
    // Idle owners only; normal worker path applies briefing and verify.
    check("busy owners skip, dispatch reuses the worker path",
      main.includes("if (inst.busy) continue;")
      && main.includes("const result = await this.dispatchRun(inst.id, task.text);"));
    // Dead entries pruned; failures logged without throwing.
    check("dead entries pruned, tick never throws",
      main.includes("if (!live.has(key)) this.scheduledNextRuns.delete(key);")
      && main.includes("} catch (err) {")
      && main.includes("console.warn(`[main] schedule tick failed:"));
    // Timer lifecycle follows the app.
    check("tick timer starts and stops with the app",
      main.includes("this.startScheduleTick();")
      && main.includes("this.stopScheduleTick();"));
    assert.ok(checks.length >= 5);
  });
});
