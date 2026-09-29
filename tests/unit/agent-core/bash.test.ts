import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashInvocation, runBash } from "../../../agent-core/main/bash.ts";

describe("runBash process ownership", () => {
  it("wraps the command so the shell waits for its jobs on EXIT", () => {
    expect(bashInvocation("printf hi")).toBe("trap -- wait EXIT\nprintf hi");
  });

  it("preserves exit status with the EXIT wait trap", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-bash-"));
    try {
      const result = await runBash("printf out; printf err >&2; exit 7", { cwd: root });
      expect(result.exitCode).toBe(7);
      expect(result.isError).toBe(true);
      expect(result.stdout?.text).toBe("out");
      expect(result.stderr?.text).toBe("err");
      expect(result.continuation).toContain("The command failed (exit 7)");
      expect(result.continuation).not.toContain("narrower output");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not return until a background job finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-bash-"));
    try {
      const started = Date.now();
      const result = await runBash(
        "(sleep 0.35; printf done > bg.txt) & printf started",
        { cwd: root, timeoutMs: 5_000 },
      );
      expect(result.state).toBe("complete");
      expect(result.content).toMatch(/started/);
      expect(readFileSync(join(root, "bg.txt"), "utf8")).toBe("done");
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("waits for disowned jobs via the process group", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-bash-"));
    try {
      const result = await runBash(
        "(sleep 0.35; printf done > disown.txt) & disown; printf started",
        { cwd: root, timeoutMs: 5_000 },
      );
      expect(result.state).toBe("complete");
      expect(readFileSync(join(root, "disown.txt"), "utf8")).toBe("done");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says a failed command failed when its output was also cut", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-bash-"));
    try {
      const result = await runBash(
        `${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(30000)); process.exit(3)'`,
        { cwd: root },
      );
      expect(result.isError).toBe(true);
      expect(result.exitCode).toBe(3);
      expect(result.truncated).toBe(true);
      expect(result.continuation).toContain("The command failed (exit 3)");
      expect(result.continuation).toContain("Output was cut");
      expect(result.continuation).not.toMatch(/^Re-run the command/);
      expect(result.content).toContain("The command failed (exit 3)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says an interrupted command was interrupted, even though the kill looks like a signal failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-bash-"));
    try {
      const result = await runBash("sleep 5", { cwd: root, timeoutMs: 5_000, shouldStop: () => true });
      expect(result.state).toBe("interrupted");
      expect(result.isError).toBe(true);
      expect(result.continuation).toContain("The command was interrupted");
      expect(result.continuation).not.toContain("The command failed");
      expect(result.content).toContain("The command was interrupted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("kills the process group on timeout so background jobs cannot leak", async () => {
    const root = mkdtempSync(join(tmpdir(), "termina-bash-"));
    try {
      const leaked = join(root, "leaked.txt");
      const result = await runBash(
        "(sleep 1; printf leaked > leaked.txt) & printf started",
        { cwd: root, timeoutMs: 150 },
      );
      expect(result.state).toBe("timeout");
      expect(result.continuation).toContain("The command timed out");
      expect(result.continuation).not.toContain("The command failed");
      expect(result.content).toContain("The command timed out");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(existsSync(leaked)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
