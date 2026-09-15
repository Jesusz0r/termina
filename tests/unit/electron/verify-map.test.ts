/**
 * One-ticket-one-run map (#237).
 *
 * A verify run id maps to at most one finding ticket. A second ticket
 * that cites the same run fails closed.
 */
import { describe, expect, it } from "vitest";
import { createVerifyMap } from "../../../electron/verify-map.ts";

describe("one-ticket-one-run verify map (#237)", () => {
  it("maps one verify run to one ticket", () => {
    const map = createVerifyMap();
    expect(map.cite("verify-1", "ticket-a")).toEqual({
      ok: true,
      verifyRunId: "verify-1",
      ticketId: "ticket-a",
    });
    expect(map.ticketFor("verify-1")).toBe("ticket-a");
  });

  it("allows the same ticket to cite the same run again", () => {
    const map = createVerifyMap();
    expect(map.cite("verify-1", "ticket-a").ok).toBe(true);
    expect(map.cite("verify-1", "ticket-a")).toEqual({
      ok: true,
      verifyRunId: "verify-1",
      ticketId: "ticket-a",
    });
  });

  it("fails closed when a second ticket cites the same verify run", () => {
    const map = createVerifyMap();
    expect(map.cite("verify-1", "ticket-a").ok).toBe(true);
    expect(map.cite("verify-1", "ticket-b")).toEqual({
      ok: false,
      error: "verify run already closes ticket ticket-a",
      verifyRunId: "verify-1",
      ticketId: "ticket-b",
      existingTicketId: "ticket-a",
    });
    expect(map.ticketFor("verify-1")).toBe("ticket-a");
  });

  it("lets two tickets cite distinct verify runs", () => {
    const map = createVerifyMap();
    expect(map.cite("verify-1", "ticket-a").ok).toBe(true);
    expect(map.cite("verify-2", "ticket-b").ok).toBe(true);
    expect(map.ticketFor("verify-2")).toBe("ticket-b");
  });

  it("fails closed on empty ids", () => {
    const map = createVerifyMap();
    expect(map.cite("  ", "ticket-a").ok).toBe(false);
    expect(map.cite("verify-1", "").ok).toBe(false);
    expect(map.ticketFor("")).toBeNull();
  });
});
