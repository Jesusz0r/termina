import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitSubagentAdmission,
  loneSubagentRollback,
  readSubagentDecisionFile,
  rewindSubagentInboxMessage,
  appendSubagentInboxMessage,
  subagentLiveFileName,
  subagentMarkerExists,
  subagentMutationBlock,
  withSubagentCommitLock,
  writeSubagentClaimsFile,
} from "../../../agent-core/subagents.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("subagent claim enforcement", () => {
  it("refuses a sibling claim and allows the owner's own path", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-claims-"));
    roots.push(dir);
    expect(writeSubagentClaimsFile(dir, "term-7", [
      { runId: "bg-1", paths: ["/proj/src/a.ts"] },
      { runId: "bg-2", paths: ["/proj/src/b.ts"] },
    ])).toBe(true);
    expect(subagentMutationBlock(dir, "term-7", "bg-2", "/proj/src/a.ts")).toMatch(/sibling/);
    expect(subagentMutationBlock(dir, "term-7", "bg-2", "/proj/src/b.ts")).toBeNull();
    expect(subagentMutationBlock(dir, "term-7", null, "/proj/src/a.ts")).toMatch(/sibling/);
    expect(subagentMutationBlock(dir, "term-7", "bg-1", "/proj/other.ts")).toBeNull();
  });

  it("fails closed on a malformed claim manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-claims-bad-"));
    roots.push(dir);
    writeFileSync(join(dir, "subagent-term-7.claims.json"), "{", { mode: 0o600 });
    expect(subagentMutationBlock(dir, "term-7", "bg-1", "/proj/a.ts")).toMatch(/write refused/);
  });

  it("treats a missing manifest as no sibling claims", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-claims-miss-"));
    roots.push(dir);
    expect(subagentMutationBlock(dir, "term-7", "bg-1", "/proj/a.ts")).toBeNull();
  });

  it("rolls a committed inbox message back without resetting the sequence", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-rewind-"));
    roots.push(dir);
    expect(appendSubagentInboxMessage(dir, "term-7", "bg-1", "keep").seq).toBe(1);
    const late = appendSubagentInboxMessage(dir, "term-7", "bg-1", "too late");
    expect(late.ok).toBe(true);
    if (!late.ok) return;
    expect(rewindSubagentInboxMessage(dir, "term-7", "bg-1", late.seq)).toBe(true);
    const next = appendSubagentInboxMessage(dir, "term-7", "bg-1", "after");
    expect(next).toEqual({ ok: true, seq: 3 });
  });

  it("lets the first admission win and ignores a stale admit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-admit-"));
    roots.push(dir);
    const first = await withSubagentCommitLock(dir, "term-7", "bg-1", () =>
      commitSubagentAdmission(dir, "term-7", "bg-1", 10, { admitted: true }),
    );
    const second = await withSubagentCommitLock(dir, "term-7", "bg-1", () =>
      commitSubagentAdmission(dir, "term-7", "bg-1", 10, { admitted: false, error: "too late" }),
    );
    expect(first).toEqual({ ok: true, value: { admitted: true } });
    expect(second).toEqual({ ok: true, value: { admitted: true } });
    expect(subagentMarkerExists(dir, subagentLiveFileName("term-7", "bg-1"))).toBe(true);
    expect(readSubagentDecisionFile(dir, "term-7", "bg-1", 99).status).toBe("stale");
    const replacement = await withSubagentCommitLock(dir, "term-7", "bg-1", () =>
      commitSubagentAdmission(dir, "term-7", "bg-1", 99, { admitted: false, error: "this boot" }),
    );
    expect(replacement).toEqual({ ok: true, value: { admitted: false, error: "this boot" } });
  });

  it("rolls back only a fan-out that collapsed to one new child", () => {
    expect(loneSubagentRollback(0, 2, 1)).toBe(true);
    expect(loneSubagentRollback(1, 2, 1)).toBe(false);
    expect(loneSubagentRollback(0, 2, 2)).toBe(false);
    expect(loneSubagentRollback(0, 1, 1)).toBe(false);
  });
});
