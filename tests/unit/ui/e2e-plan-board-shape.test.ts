import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const spec = readFileSync(new URL("../../../tests/e2e/plan-board.spec.ts", import.meta.url), "utf8");

/**
 * Guards the Plan Board E2E against regressing to injected markup (refs #147).
 * The spec itself drives the production sidecar → main → render path; these
 * assertions fail fast (without launching Electron) if hand-authored plan HTML
 * ever replaces the production event seeding again.
 */
describe("plan board spec shape (refs #147)", () => {
  it("publishes plans through the real agent, never fabricated events or DOM", () => {
    expect(spec).toContain("/plan plan-board-e2e-owner");
    expect(spec).toContain("window.termina.writeTerminal");
    expect(spec).toContain("response.output_item.done");
    expect(spec).not.toContain("appendFileSync");
    expect(spec).toContain("plan:update");
    expect(spec).not.toContain("innerHTML");
    expect(spec).not.toContain("plan-checkbox");
  });

  it("asserts the production row shape, a subsequent update, and the dispatch action", () => {
    expect(spec).toContain(".plan-task");
    expect(spec).toContain("state-pending");
    expect(spec).toContain("state-done");
    expect(spec).toContain(".plan-mark");
    expect(spec).toContain(".plan-model");
    expect(spec).toContain("dispatchable");
    expect(spec).toContain("toHaveCount(3");
    expect(spec).toContain('hasText: "dispatch"');
  });
});
