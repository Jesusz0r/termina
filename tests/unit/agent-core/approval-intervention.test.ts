import { describe, expect, it, vi } from "vitest";
import { ApprovalPicker } from "../../../agent-core/main/approval.ts";

const rows = [{ name: "Deny", hint: "reject", submit: "/approve deny" }];
function fixture() {
  const events: Array<Record<string, unknown>> = [];
  const surface = { active: () => true, setChoices: vi.fn(), clearChoices: vi.fn() };
  const picker = new ApprovalPicker(() => surface, (event) => events.push({ ...event }));
  return { events, surface, picker };
}

describe("human permission picker lifecycle", () => {
  it.each(["/approve deny", "/approve once", "/approve always", "/approve protected"])("pairs %s without leaking prompt content", async (answer) => {
    const { picker, events, surface } = fixture();
    const before = Date.now();
    const pending = picker.ask("secret command", rows);
    expect(surface.setChoices).toHaveBeenCalledOnce();
    const requested = { ...events[0] };
    expect(requested).toEqual({ t: "intervention_requested", requestId: expect.any(String), kind: "permission", since: expect.any(Number) });
    expect(String(requested.requestId).length).toBeLessThanOrEqual(128);
    expect(Number(requested.since)).toBeGreaterThanOrEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([requested]); // Waiting preserves the original age.
    expect(picker.answer(answer)).toBe(true);
    expect(await pending).toBe(answer);
    expect(events[1]).toEqual({ t: "intervention_resolved", requestId: requested.requestId });
    expect(surface.clearChoices).toHaveBeenCalledOnce();
    expect(picker.pending).toBe(false);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("cancels once and gives each new surface a unique id", async () => {
    const { picker, events } = fixture();
    const first = picker.ask("first", rows);
    expect(picker.cancel()).toBe(true);
    expect(picker.cancel()).toBe(false);
    expect(await first).toBe("/approve deny");
    const second = picker.ask("second", rows);
    picker.cancel();
    await second;
    expect(events[0].requestId).not.toBe(events[2].requestId);
    expect(events).toHaveLength(4);
  });

  it("does not publish an unavailable or failed surface", async () => {
    const { picker, surface, events } = fixture();
    surface.active = () => false;
    expect(await picker.ask("headless wait", rows)).toBe("/approve deny");
    surface.active = () => true;
    surface.setChoices.mockImplementation(() => { throw new Error("display failed"); });
    await expect(picker.ask("failed", rows)).rejects.toThrow("display failed");
    expect(events).toEqual([]);
    expect(picker.pending).toBe(false);
  });

  it("resolves even when surface teardown throws", async () => {
    const { picker, surface, events } = fixture();
    const pending = picker.ask("prompt", rows);
    surface.clearChoices.mockImplementation(() => { throw new Error("teardown failed"); });
    picker.cancel();
    await expect(pending).rejects.toThrow("teardown failed");
    expect(events[1]).toEqual({ t: "intervention_resolved", requestId: events[0].requestId });
    expect(picker.pending).toBe(false);
  });

  it("denies an expired displayed request and clears its picker", async () => {
    const { picker, surface, events } = fixture();
    expect(await picker.ask("expired child", rows, 15)).toBe("/approve deny");
    expect(surface.clearChoices).toHaveBeenCalledOnce();
    expect(events[1]).toEqual({ t: "intervention_resolved", requestId: events[0].requestId });
    expect(picker.pending).toBe(false);
  });
});
