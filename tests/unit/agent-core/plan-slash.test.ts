import { describe, expect, it } from "vitest";

import { PLAN_SIDECAR_TEXT_CAP, planSidecarText, planSlashSubmit } from "../../../agent-core/main/plan-slash.ts";
import { planListPresent } from "../../../shared/plan-task.ts";

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

  it("keeps a headed list when a preamble would exceed the cap", () => {
    const list = "Plan:\n- [ ] edit src/auth.ts\n";
    const text = `${"preamble\n".repeat(4_000)}${list}`;
    expect(text.length).toBeGreaterThan(PLAN_SIDECAR_TEXT_CAP);
    const published = planSidecarText(text, "");
    expect(published?.startsWith("Plan:")).toBe(true);
    expect(published).toContain("- [ ] edit src/auth.ts");
    expect(planListPresent(published ?? "")).toBe(true);
  });
});

describe("planListPresent", () => {
  it("accepts a headed task list and rejects a clarifying question", () => {
    expect(planListPresent("What feature should I plan?")).toBe(false);
    expect(planListPresent("Plan:\n- [ ] edit src/auth.ts\n")).toBe(true);
    expect(planListPresent("## Plan\n\nHere is the work:\n- [ ] edit src/auth.ts\n")).toBe(true);
    expect(planListPresent("plan for the weekend\n- [ ] edit src/foo.ts\n")).toBe(false);
  });
});
