import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for background scheduling: due `@every` / `@at` plan
 * tasks dispatch through the normal worker path, idle owners only, with
 * dead-entry pruning and lifecycle-bounded timers. Pure marker math lives in
 * plan-board.test.ts; the tick lives in electron/schedule.ts with a live
 * host traversal in main. This probe covers the wiring across both.
 */
describe("Schedule Tick Invariants", () => {
  it("ticks due schedules through dispatch with idle-only guards", async () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const schedule = readFileSync(new URL("../../../electron/schedule.ts", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    // Only pending scheduled tasks participate (live host traversal in main).
    check("tick scans pending scheduled tasks",
      main.includes("if (task.state !== \"pending\") continue;")
      && main.includes("const spec = parseScheduleMarker(task.text);"));
    // Reschedule before dispatch so slow workers never pile up ticks.
    check("reschedule precedes dispatch",
      /this\.scheduledNextRuns\.set\(key, nextScheduleRun\(task\.spec, now, false\)\);\n\s+if \(task\.isBusy\(\)\) continue;/.test(schedule));
    // Idle owners only; normal worker path applies briefing and verify.
    check("busy owners skip, dispatch reuses the worker path",
      schedule.includes("if (task.isBusy()) continue;")
      && schedule.includes("const result = await this.host.dispatchRun(task.ownerId, task.text);"));
    // Dead entries pruned; failures logged without throwing.
    check("dead entries pruned, tick never throws",
      schedule.includes("if (!live.has(key)) this.scheduledNextRuns.delete(key);")
      && schedule.includes("} catch (err) {")
      && schedule.includes("console.warn(`[main] schedule tick failed:"));
    // Timer lifecycle follows the app.
    check("tick timer starts and stops with the app",
      main.includes("this.schedules.start();")
      && main.includes("this.schedules.stop();")
      && schedule.includes("}, SCHEDULE_TICK_MS);"));
    assert.ok(checks.length >= 5);
  });
});
