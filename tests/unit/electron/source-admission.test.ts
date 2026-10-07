import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceAdmissions, sourceTreesOverlap, type SourceClaim } from "../../../electron/main/source-admission.ts";

const claim = (id = "a", generation = 1, root = "/repo", groupId = id): SourceClaim =>
  ({ id, generation, root, groupId, kind: "agent" });

describe("sourceTreesOverlap", () => {
  it.each([
    ["/repo", "/repo", true],
    ["/repo", "/repo/src", true],
    ["/repo/src", "/repo", true],
    ["/repo", "/other", false],
    ["/repo", "/repo-other", false],
    ["/repo", "/repo/..foo", true],
    ["/repo/..foo", "/repo", true],
    ["/repo", "/Repo", false],
  ])("compares %s and %s: %s", (a, b, overlaps) => {
    expect(sourceTreesOverlap(a, b)).toBe(overlaps);
  });
});

describe("SourceAdmissions", () => {
  let children: Set<string>;
  let expired: ReturnType<typeof vi.fn<(claim: SourceClaim) => void>>;
  let admissions: SourceAdmissions;
  beforeEach(() => {
    vi.useFakeTimers();
    children = new Set();
    expired = vi.fn();
    admissions = new SourceAdmissions(id => children.has(id), expired);
  });
  afterEach(() => {
    admissions.dispose();
    vi.useRealTimers();
  });

  it("reserves synchronously: the first overlapping admit wins", () => {
    const first = claim();
    expect(admissions.admit(first)).toEqual({ ok: true });
    expect(admissions.admit(claim("b", 1, "/repo/src"))).toEqual({ ok: false, conflict: first });
    expect(admissions.admit(claim("c", 1, "/repo-other"))).toEqual({ ok: true });
  });

  it("allows equal and nested roots only for an explicit coordinated group", () => {
    expect(admissions.admit(claim("a", 1, "/repo", "team"))).toEqual({ ok: true });
    expect(admissions.admit({ ...claim("b", 1, "/repo/src", "team"), kind: "shell" })).toEqual({ ok: true });
    expect(admissions.admit(claim("c", 1, "/repo", "team"))).toEqual({ ok: true });
    admissions.dispose();
    const anonymous = claim("a", 1, "/repo", "");
    admissions.admit(anonymous);
    expect(admissions.admit(claim("b", 1, "/repo", ""))).toEqual({ ok: false, conflict: anonymous });
  });

  it("keeps generations independent and fences late finish and removal", () => {
    admissions.admit(claim("a", 1));
    admissions.admit(claim("a", 2));
    admissions.start("a", 2);
    admissions.finish("a", 1);
    admissions.remove("a", 1);
    vi.advanceTimersByTime(60_000);
    expect(expired).not.toHaveBeenCalled();
    expect(admissions.admit(claim("b"))).toEqual({ ok: false, conflict: claim("a", 2) });
    admissions.finish("a", 2);
    expect(admissions.admit(claim("b"))).toEqual({ ok: true });
  });

  it("expires pending reservations at exactly 60 seconds", () => {
    const pending = claim();
    admissions.admit(pending);
    vi.advanceTimersByTime(59_999);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expired).toHaveBeenCalledExactlyOnceWith(pending);
    expect(admissions.admit(claim("b"))).toEqual({ ok: true });
  });

  it("retains children on pending expiry and has no retained deadline", () => {
    const pending = claim();
    children.add("a");
    admissions.admit(pending);
    vi.advanceTimersByTime(60_000);
    expect(expired).toHaveBeenCalledExactlyOnceWith(pending);
    expect(vi.getTimerCount()).toBe(0);
    expect(admissions.admit(claim("b"))).toEqual({ ok: false, conflict: pending });
    admissions.releaseRetained("a");
    expect(admissions.admit(claim("b"))).toEqual({ ok: false, conflict: pending });
    children.delete("a");
    admissions.releaseRetained("a");
    expect(admissions.admit(claim("b"))).toEqual({ ok: true });
  });

  it("start cancels expiry and finish releases live work", () => {
    admissions.admit(claim());
    admissions.start("a", 1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(expired).not.toHaveBeenCalled();
    expect(admissions.admit(claim("b")).ok).toBe(false);
    admissions.finish("a", 1);
    expect(admissions.admit(claim("b")).ok).toBe(true);
  });

  it.each([false, true])("late child completion cannot release new work (live=%s)", live => {
    children.add("a");
    admissions.admit(claim());
    admissions.finish("a", 1);
    admissions.admit(claim());
    if (live) admissions.start("a", 1);
    children.delete("a");
    admissions.releaseRetained("a");
    expect(admissions.admit(claim("b")).ok).toBe(false);
  });

  it("re-admits retained ownership as pending with a new deadline", () => {
    children.add("a");
    admissions.admit(claim());
    admissions.finish("a", 1);
    children.delete("a");
    admissions.admit(claim());
    vi.advanceTimersByTime(60_000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(admissions.admit(claim("b")).ok).toBe(true);
  });

  it.each(["finish", "expiry"])("preserves live ownership after failed self preparation: %s", failure => {
    admissions.admit(claim());
    admissions.start("a", 1);
    admissions.admit(claim());
    if (failure === "finish") admissions.finish("a", 1);
    else vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(admissions.admit(claim("b")).ok).toBe(false);
    admissions.finish("a", 1);
    expect(admissions.admit(claim("b")).ok).toBe(true);
  });

  it("replaces only the exact self reservation and cancels its old deadline", () => {
    const original = claim();
    admissions.admit(original);
    expect(admissions.admit(claim("a", 1, "/other"))).toEqual({ ok: false, conflict: original });
    expect(admissions.admit(claim("a", 1, "/repo", "other"))).toEqual({ ok: false, conflict: original });
    vi.advanceTimersByTime(30_000);
    admissions.admit(original);
    vi.advanceTimersByTime(30_000);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("removes failed spawns unconditionally and clears their timer", () => {
    children.add("a");
    admissions.admit(claim());
    admissions.remove("a", 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(admissions.admit(claim("b")).ok).toBe(true);
  });

  it("dispose clears all owned timers and reservations", () => {
    admissions.admit(claim());
    admissions.admit(claim("b", 1, "/other"));
    admissions.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(expired).not.toHaveBeenCalled();
    expect(admissions.admit(claim("c")).ok).toBe(true);
  });
});
