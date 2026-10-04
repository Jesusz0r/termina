import { describe, expect, it } from "vitest";
import { formatVerifyContext, isVerifySourceCurrent, invalidateVerify, parseStoredVerify, parseStoredVerifyOutput, verifyOutputTail } from "../../../electron/main/verify-source.ts";
import type { VerifyInfo, VerifySource } from "../../../shared/types.ts";

const source: VerifySource = { workspaceId: "ws-1", root: "/project", tree: "a".repeat(40), revision: 3, observationEpoch: 1, generation: 4 };

describe("live Verify source validity", () => {
  it("requires an observed matching source rather than only an exit code", () => {
    expect(isVerifySourceCurrent(source, { ...source })).toBe(true);
    expect(isVerifySourceCurrent(undefined, source)).toBe(false);
    expect(isVerifySourceCurrent(source, undefined)).toBe(false);
    for (const changed of [
      { workspaceId: "ws-2" }, { root: "/other" }, { tree: "b".repeat(40) },
      { revision: 4 }, { observationEpoch: 2 }, { generation: 5 },
    ]) expect(isVerifySourceCurrent(source, { ...source, ...changed })).toBe(false);
  });

  it("keeps the actual result and source when current validity is lost", () => {
    const verify: VerifyInfo = {
      state: "pass", command: "npm run test", summary: "tests green", source,
      result: { state: "pass", exitCode: 0, startedAt: 1, finishedAt: 2 },
    };
    const stale = invalidateVerify(verify, "source changed");
    expect(stale.state).toBe("stale");
    expect(stale.staleReason).toBe("source changed");
    expect(stale.result).toEqual(verify.result);
    expect(stale.source).toEqual(source);
    expect(stale.command).toBe("npm run test");
    expect(verify.state).toBe("pass");
    expect(invalidateVerify(stale, "changed again")).toBe(stale);
  });

  it("does not invent a result or interrupt a currently running verification", () => {
    for (const state of ["untested", "running"] as const) {
      const verify = { state, command: null, summary: null };
      expect(invalidateVerify(verify, "source changed")).toBe(verify);
    }
  });

  it("round-trips bounded historical metadata but rejects malformed evidence", () => {
    const verify: VerifyInfo = {
      state: "stale", command: "npm run test", summary: "outdated", staleReason: "source changed", source,
      result: { state: "pass", exitCode: 0, startedAt: 1, finishedAt: 2 },
    };
    expect(parseStoredVerify(JSON.parse(JSON.stringify(verify)))).toEqual(verify);
    for (const change of [{ tree: "not-an-oid" }, { root: "relative" }, { revision: -1 }, { observationEpoch: 0.5 }, { generation: NaN }]) {
      expect(parseStoredVerify({ ...verify, source: { ...source, ...change } })?.source).toBeUndefined();
    }
    for (const change of [{ state: "running" }, { exitCode: 0.5 }, { startedAt: 3 }, { finishedAt: Number.MAX_SAFE_INTEGER }]) {
      expect(parseStoredVerify({ ...verify, result: { ...verify.result, ...change } })?.result).toBeUndefined();
    }
    expect(parseStoredVerify({ state: "running" })).toBeUndefined();
    const legacy = parseStoredVerify({ state: "pass", command: "npm run test", summary: "tests green" })!;
    expect(invalidateVerify(legacy, "previous session").state).toBe("stale");
    expect(invalidateVerify(legacy, "previous session").source).toBeUndefined();
  });

  it("bounds persisted output in bytes and distinguishes absent history from an empty execution", () => {
    expect(parseStoredVerifyOutput("🌿".repeat(1500))).toHaveLength(3000);
    expect(parseStoredVerifyOutput("🌿".repeat(1501))).toBeUndefined();
    expect(parseStoredVerifyOutput({ output: "nope" })).toBeUndefined();
    const tail = verifyOutputTail("日本🌿".repeat(3000));
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(6000);
    expect(tail).not.toContain("�");
    expect(tail.endsWith("日本🌿")).toBe(true);
    const untested = formatVerifyContext({ state: "untested", command: null, summary: null }, null);
    expect(untested).toContain("**Status:** NOT RUN");
    expect(untested).not.toContain("PASSED");
    expect(formatVerifyContext({ state: "stale", command: "npm run test", summary: "outdated" }, null)).toContain("not retained for this historical run");
  });

  it("labels stale agent context explicitly without erasing the historical pass", () => {
    const verify = invalidateVerify({
      state: "pass", command: "npm run test", summary: "tests green", source,
      result: { state: "pass", exitCode: 0, startedAt: 1, finishedAt: 2 },
    }, "source changed");
    const context = formatVerifyContext(verify, "日本🌿".repeat(3000));
    expect(context).toContain("**Status:** ⚠️ OUTDATED");
    expect(context).toContain("**Historical execution:** ✅ PASSED (exit code 0)");
    expect(context).toContain(source.root);
    expect(context).toContain(source.tree);
    expect(context).toContain("**Elapsed:** 1 ms");
    expect(context).not.toContain("�");
    expect(Buffer.byteLength(context, "utf8")).toBeLessThan(7000);
  });
});
