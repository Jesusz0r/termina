import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for dispatch auto-verify: a worker that settles with
 * its task done triggers one background verify for an idle owner, and the
 * finish path reports the verdict to the owner's mailbox exactly once.
 * Electron e2e covers the visible verify flow; this probe covers the
 * no-loop, no-interference wiring without a live display server.
 */
describe("Dispatch Auto-Verify Invariants", () => {
  it("wires worker settle to one idle-owner verify with a mailbox verdict", async () => {
    const main = readFileSync(new URL("../../../electron/main.ts", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    // Settle path offers auto-verify only for completed tasks.
    check("settle offers auto-verify on task completion",
      main.includes("this.maybeAutoVerify(ownerInst, task?.state === \"done\" ? task.text : null)"));
    // Guards: idle owner only, no duplicate or overlapping verify.
    check("auto-verify requires an idle open owner",
      main.includes("if (!taskText || owner.busy || owner.closed) return;"));
    check("auto-verify never overlaps a running or pending verify",
      main.includes("if (this.verifyRuns.has(owner.id) || this.autoVerifyTasks.has(owner.id)) return;"));
    check("auto-verify waits while a sibling worker still runs",
      main.includes("for (const id of this.dispatchGroupIds(owner.id)) {")
      && main.includes("if (sibling && !sibling.closed && sibling.busy) return;"));
    // One shot: consumed at finish start (even when the terminal is gone),
    // startup failure clears the pending entry without a note.
    check("finish consumes the pending entry before the terminal check",
      /const autoTask = this\.autoVerifyTasks\.get\(ownerId\) \?\? null;\n\s+this\.autoVerifyTasks\.delete\(ownerId\);\n[\s\S]{0,400}if \(this\.terminals\.get\(ownerId\) !== owner/.test(main));
    check("verify startup failure clears the pending entry",
      main.includes("void this.runVerify(owner.id).then((result) => {")
      && main.includes("if (!result.ok) this.autoVerifyTasks.delete(owner.id);"));
    // Verdict note only for real outcomes, never for cancellations.
    check("mailbox verdict skips cancelled runs",
      main.includes("if (autoTask && how !== \"cancelled\") {")
      && main.includes("## Auto-verify\\n"));
    // Retry loop: failures seed consecutive attempts, owner settle re-runs
    // while attempts remain, the cap stops with a needs-attention note, and
    // pass/cancel/close clear the entry.
    check("failures seed bounded retry attempts",
      main.includes("const attempts = (this.autoVerifyFailures.get(ownerId) ?? 0) + 1;")
      && main.includes("if (attempts >= TerminaApp.MAX_AUTO_VERIFY_ATTEMPTS) {"));
    check("cap stops the loop with a needs-attention note",
      main.includes("consecutive failed verifies — needs attention before another automatic run."));
    check("timeouts report once and never schedule a retry",
      main.includes("} else if (how === \"timeout\") {")
      && main.includes("automatic re-verify is disabled for timeouts"));
    check("owner settle re-verifies while attempts remain",
      main.includes("} else if (inst.type === \"agent\") {")
      && main.includes("this.maybeAutoReverify(inst);"));
    check("reverify honors idle/sibling/overlap guards",
      main.includes("const attempts = this.autoVerifyFailures.get(owner.id);")
      && main.includes("if (attempts === undefined || owner.busy || owner.closed) return;"));
    check("close and exit clear retry state",
      main.includes("this.autoVerifyFailures.delete(id);")
      && main.includes("this.autoVerifyFailures.delete(inst.id);"));
    assert.ok(checks.length >= 10);
  });
});
