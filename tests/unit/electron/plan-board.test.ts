import { describe, it, expect } from "vitest";
import {
  MIN_SCHEDULE_INTERVAL_MS,
  nextScheduleRun,
  parsePlanTasks,
  parseScheduleMarker,
} from "../../../electron/plan-board.ts";

describe("Plan Board Task Parser Contract", () => {
  it("accepts a headed list with bullet, numbered, unchecked, and checked variants", async () => {
    const parsedSyntaxes = await parsePlanTasks(
      "## Plan\n\n- dash\n* star\n+ plus\n1. numbered dot\n2) numbered paren\n- [ ] unchecked\n* [x] checked lower\n+ [X] checked upper",
      null,
      (path: string) => path,
    );

    const summary = parsedSyntaxes.map((task) => `${task.text}:${task.state}`).join("|");
    expect(summary).toBe(
      "dash:pending|star:pending|plus:pending|numbered dot:pending|numbered paren:pending|unchecked:pending|checked lower:done|checked upper:done",
    );
  });

  it("ignores ordinary summary bullets when no plan heading or tasks exist", async () => {
    const summaryTasks = await parsePlanTasks(
      "Cleanup complete:\n\n- Deleted branches\n- Working tree is clean",
      null,
      (path: string) => path,
    );

    expect(summaryTasks.length).toBe(0);
  });

  it("associates relative paths mentioned in tasks", async () => {
    const tasks = await parsePlanTasks(
      "Plan:\n- [ ] Create src/utils.ts for math helpers\n- [x] Edit greeting.ts to say hello",
      null,
      (path: string) => path,
    );

    expect(tasks.length).toBe(2);
    expect(tasks[0].state).toBe("pending");
    expect(tasks[1].state).toBe("done");
  });
});

describe("Plan Board Schedule Markers", () => {
  it("parses every/at markers and rejects the rest", () => {
    expect(parseScheduleMarker("lint @every 30m")).toEqual({ kind: "every", intervalMs: 30 * 60_000 });
    expect(parseScheduleMarker("lint @every 2h")).toEqual({ kind: "every", intervalMs: 2 * 3_600_000 });
    expect(parseScheduleMarker("standup @at 09:30")).toEqual({ kind: "at", hour: 9, minute: 30 });
    expect(parseScheduleMarker("plain task")).toBeNull();
    expect(parseScheduleMarker("lint @every 30x")).toBeNull();
    expect(parseScheduleMarker("standup @at 25:00")).toBeNull();
  });

  it("rejects intervals below the minimum", () => {
    expect(parseScheduleMarker("lint @every 30s")).toBeNull();
    expect(parseScheduleMarker("lint @every 4m")).toBeNull();
    expect(parseScheduleMarker(`lint @every ${MIN_SCHEDULE_INTERVAL_MS / 60_000}m`)).not.toBeNull();
  });

  it("fires every-intervals immediately at first, then by interval", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const spec = parseScheduleMarker("lint @every 1h")!;
    expect(nextScheduleRun(spec, now, true)).toBe(now);
    expect(nextScheduleRun(spec, now, false)).toBe(now + 3_600_000);
  });

  it("schedules at-markers for the next occurrence", () => {
    const noon = new Date(2026, 0, 1, 12, 0, 0).getTime();
    const morning = parseScheduleMarker("standup @at 09:30")!;
    const evening = parseScheduleMarker("sync @at 18:00")!;
    const nextMorning = new Date(nextScheduleRun(morning, noon, false));
    expect(nextMorning.getHours()).toBe(9);
    expect(nextMorning.getDate()).toBe(2);
    const nextEvening = new Date(nextScheduleRun(evening, noon, false));
    expect(nextEvening.getHours()).toBe(18);
    expect(nextEvening.getDate()).toBe(1);
  });
});
