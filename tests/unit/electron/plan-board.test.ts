import { describe, it, expect } from "vitest";
import { parsePlanTasks } from "../../../electron/plan-board.ts";

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
