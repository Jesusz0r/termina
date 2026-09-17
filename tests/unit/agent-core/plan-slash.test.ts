import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PLAN_SIDECAR_TEXT_CAP, planSidecarText, planSlashSubmit } from "../../../agent-core/main/plan-slash.ts";

const LIST = "Plan:\n- [ ] src/a.ts\n";

describe("planSlashSubmit", () => {
  it("rewrites /plan into a Plan Board instruction", () => {
    const text = planSlashSubmit("/plan");
    expect(text).toContain("Write a Plan Board list. Do not implement.");
    expect(text).toContain("`Plan:`");
    expect(text).toContain("`## Plan`");
    expect(text).toContain("- [ ]");
    expect(text).toContain("@model provider/id");
    expect(text).not.toContain("Request:");
  });

  it("appends the rest of /plan as the request", () => {
    const text = planSlashSubmit("/plan fix auth in src/auth.ts");
    expect(text).toContain("Write a Plan Board list. Do not implement.");
    expect(text).toContain("Request:\nfix auth in src/auth.ts");
  });

  it("leaves other slash lines unchanged", () => {
    expect(planSlashSubmit("/compact")).toBeNull();
    expect(planSlashSubmit("/planning")).toBeNull();
    expect(planSlashSubmit("plan this")).toBeNull();
  });
});

describe("planSidecarText", () => {
  it("publishes the assistant text, including prose", () => {
    expect(planSidecarText(LIST, "")).toBe(LIST);
    expect(planSidecarText("What should I plan?", "")).toBe("What should I plan?");
  });

  it("skips empty and unchanged payloads", () => {
    expect(planSidecarText("   ", "")).toBeNull();
    expect(planSidecarText(LIST, LIST)).toBeNull();
  });

  it("caps the sidecar payload", () => {
    const text = "x".repeat(PLAN_SIDECAR_TEXT_CAP + 8);
    expect(planSidecarText(text, "")).toBe(text.slice(0, PLAN_SIDECAR_TEXT_CAP));
  });
});

describe("engine plan publish", () => {
  it("logs /plan-turn assistant text; parsePlanTasks is the detector", () => {
    const main = readFileSync(new URL("../../../agent-core/main.ts", import.meta.url), "utf8");
    expect(main).toContain("submit(planPrompt, true)");
    expect(main).toContain("planTurn ? planSidecarText(assistantText, lastPlanText) : null");
    expect(main).toContain("queueTypedLine(line)");
    expect(main).toContain("dispatchLine(next)");
    expect(main).not.toContain("queuedPlanTurn");
    expect(main).not.toContain("planTextIfChanged");
    expect(main).not.toContain("firstPlanText");
    expect(main).not.toContain("HAS_PLAN_TASK");
  });
});
