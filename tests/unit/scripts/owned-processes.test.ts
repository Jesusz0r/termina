import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readSystemProcessIdentity } from "../../../shared/process-identity.js";
import { OwnedProcessTree } from "../../e2e/owned-processes.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("../../../shared/process-identity.js", () => ({ readSystemProcessIdentity: vi.fn() }));

describe("E2E descendant ownership", () => {
  let identities: Map<number, string>;
  let alive: Set<number>;
  let signals: Array<[number, string]>;
  let ignoreTerm: boolean;
  let listing: string;

  beforeEach(() => {
    vi.useFakeTimers();
    identities = new Map([[100, "root"], [101, "child"], [102, "grandchild"], [900, "foreign"]]);
    alive = new Set(identities.keys());
    signals = [];
    ignoreTerm = false;
    listing = "100 1\n101 100\n102 101\n900 1\n";
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      if (args[0] === "-axo") return listing;
      const pid = Number(args[1]);
      return listing.split("\n").find((line) => Number(line.split(" ")[0]) === pid)?.split(" ")[1] ?? "";
    });
    vi.mocked(readSystemProcessIdentity).mockImplementation((pid) => identities.get(pid) ?? null);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (!alive.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal !== 0) {
        signals.push([pid, String(signal)]);
        if (!ignoreTerm || signal === "SIGKILL") {
          alive.delete(pid);
          identities.delete(pid);
        }
      }
      return true;
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("remembers descendants after parent death; leaves foreign processes alone", async () => {
    const tree = new OwnedProcessTree(100);
    alive.delete(100);
    identities.delete(100);
    listing = "101 1\n102 101\n900 1\n";
    const stopped = tree.stop();
    expect(tree.stop()).toBe(stopped);
    await stopped;
    expect(signals).toEqual([[101, "SIGTERM"], [102, "SIGTERM"]]);
    expect(alive).toEqual(new Set([900]));
  });

  it("escalates stubborn owned children and waits for their exit", async () => {
    const tree = new OwnedProcessTree(100);
    ignoreTerm = true;
    const stopped = tree.stop();
    await vi.advanceTimersByTimeAsync(1_100);
    await stopped;
    expect(signals).toEqual([[101, "SIGTERM"], [102, "SIGTERM"], [101, "SIGKILL"], [102, "SIGKILL"]]);
    expect(alive).toEqual(new Set([100, 900]));
  });

  it("does not signal a reused child PID", async () => {
    const tree = new OwnedProcessTree(100);
    identities.set(101, "unrelated-new-birth");
    await tree.stop();
    expect(signals).toEqual([[102, "SIGTERM"]]);
    expect(alive.has(101)).toBe(true);
  });

  it("does not acquire descendants of a reused root PID", async () => {
    const tree = new OwnedProcessTree(100);
    identities.set(100, "new-root-birth");
    identities.set(103, "foreign-child");
    alive.add(103);
    listing = "100 1\n101 1\n102 101\n103 100\n900 1\n";
    await tree.stop();
    expect(signals.map(([pid]) => pid)).toEqual([101, 102]);
    expect(alive.has(103)).toBe(true);
  });

  it("tolerates a short-lived child exiting between census and identity read", async () => {
    listing += "103 100\n";
    const tree = new OwnedProcessTree(100);
    await tree.stop();
    expect(signals.map(([pid]) => pid)).toEqual([101, 102]);
  });

  it("does not acquire a PID whose parent changed after the census", async () => {
    identities.set(103, "foreign-new-birth");
    alive.add(103);
    listing += "103 100\n";
    const readParent = vi.mocked(execFileSync).getMockImplementation()!;
    vi.mocked(execFileSync).mockImplementation((file, args) => {
      if (args[0] === "-p" && args[1] === "103") return "900";
      return readParent(file, args);
    });
    const tree = new OwnedProcessTree(100);
    await tree.stop();
    expect(signals.map(([pid]) => pid)).toEqual([101, 102]);
    expect(alive.has(103)).toBe(true);
  });

  it("fails closed when a live child's birth identity cannot be read", async () => {
    const tree = new OwnedProcessTree(100);
    identities.delete(101);
    await expect(tree.stop()).rejects.toThrow("cannot revalidate live test descendant");
    expect(signals).toEqual([]);
  });
});
