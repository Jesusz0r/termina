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

  it("admits overlapping agents and shells on the same tree", () => {
    const first = claim();
    const shell = { ...claim("shell", 1, "/repo", "shell:/repo"), kind: "shell" as const };
    expect(admissions.admit(first)).toEqual({ ok: true });
    expect(admissions.admit(claim("b", 1, "/repo/src"))).toEqual({ ok: true });
    expect(admissions.admit(shell)).toEqual({ ok: true });
    expect(admissions.admit(claim("c", 1, "/repo-other"))).toEqual({ ok: true });
    expect(admissions.writerAt("/repo")).toEqual(first);
    admissions.finish(first.id, first.generation);
    admissions.finish("b", 1);
    admissions.finish(shell.id, shell.generation);
    expect(admissions.writerAt("/repo-other")?.id).toBe("c");
  });

  it("shares observational runs with writers but never upgrades a live reader", () => {
    const writer = claim("writer");
    const reader = { ...claim("reader"), access: "read" as const };
    expect(admissions.admit(writer)).toEqual({ ok: true });
    expect(admissions.admit(reader)).toEqual({ ok: true });
    admissions.start(reader.id, reader.generation);
    expect(admissions.admit(claim("reader"))).toEqual({ ok: false, conflict: reader });
    expect(admissions.admit(claim("rival"))).toEqual({ ok: true });
  });

  it("attributes watcher results only to the admitted writer generation", () => {
    admissions.admit(claim("writer"));
    admissions.admit({ ...claim("reader"), access: "read" });
    expect(admissions.ownsWrite("writer", 1, "/repo/file.txt")).toBe(false);
    admissions.start("writer", 1);
    expect(admissions.ownsWrite("writer", 1, "/repo/file.txt")).toBe(true);
    expect(admissions.ownsWrite("reader", 1, "/repo/file.txt")).toBe(false);
    expect(admissions.ownsWrite("writer", 2, "/repo/file.txt")).toBe(false);
    expect(admissions.ownsWrite("writer", 1, "/other/file.txt")).toBe(false);
    admissions.finish("writer", 1);
    expect(admissions.ownsWrite("writer", 1, "/repo/file.txt")).toBe(false);
  });

  it("keeps generations independent and fences late finish and removal", () => {
    admissions.admit(claim("a", 1));
    admissions.admit(claim("a", 2));
    admissions.start("a", 2);
    admissions.finish("a", 1);
    admissions.remove("a", 1);
    vi.advanceTimersByTime(60_000);
    expect(expired).not.toHaveBeenCalled();
    expect(admissions.writerAt("/repo")).toEqual(claim("a", 2));
    admissions.finish("a", 2);
    expect(admissions.writerAt("/repo")).toBeNull();
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
    expect(admissions.writerAt("/repo")).toEqual(pending);
    admissions.releaseRetained("a");
    expect(admissions.writerAt("/repo")).toEqual(pending);
    children.delete("a");
    admissions.releaseRetained("a");
    expect(admissions.writerAt("/repo")).toBeNull();
  });

  it("start cancels expiry and finish releases live work", () => {
    admissions.admit(claim());
    admissions.start("a", 1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(expired).not.toHaveBeenCalled();
    expect(admissions.writerAt("/repo")).toEqual(claim());
    admissions.finish("a", 1);
    expect(admissions.writerAt("/repo")).toBeNull();
  });

  it.each([false, true])("late child completion cannot release new work (live=%s)", live => {
    children.add("a");
    admissions.admit(claim());
    admissions.finish("a", 1);
    admissions.admit(claim());
    if (live) admissions.start("a", 1);
    children.delete("a");
    admissions.releaseRetained("a");
    expect(admissions.writerAt("/repo")).toEqual(claim());
  });

  it("re-admits retained ownership as pending with a new deadline", () => {
    children.add("a");
    admissions.admit(claim());
    admissions.finish("a", 1);
    children.delete("a");
    admissions.admit(claim());
    vi.advanceTimersByTime(60_000);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(admissions.writerAt("/repo")).toBeNull();
  });

  it.each(["finish", "expiry"])("preserves live ownership after failed self preparation: %s", failure => {
    admissions.admit(claim());
    admissions.start("a", 1);
    admissions.admit(claim());
    if (failure === "finish") admissions.finish("a", 1);
    else vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(admissions.writerAt("/repo")).toEqual(claim());
    admissions.finish("a", 1);
    expect(admissions.writerAt("/repo")).toBeNull();
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
