import { expect, it } from "vitest";
import { logicalToolText } from "../../../agent-core/tool-output.ts";
import { readProjectFiles } from "../../../agent-core/main/file-ops.ts";
import { done, formatToolFollowup } from "../../../agent-core/main/tools.ts";

it("reports invalid batch arguments without claiming truncated output or a continuation", () => {
  const result = readProjectFiles(process.cwd(), { paths: ["a", "b"], end_line: 10 });
  expect(result).toMatchObject({ state: "failed", isError: true, truncated: false, continuation: null });
  expect(result.content).toBe("error: start_line/end_line apply to a single path; omit them with paths");
});

it("still marks an actually clipped error and an interrupted search", () => {
  const clipped = logicalToolText("error: " + "x".repeat(1000), { maxBytes: 100, state: "failed", isError: true });
  expect(clipped.truncated).toBe(true);
  expect(clipped.content).toContain("output truncated");
  const partial = logicalToolText("partial hits", {
    maxBytes: 200, state: "timeout", isError: true, marker: "Search a narrower directory.",
  });
  expect(partial).toMatchObject({ state: "timeout", isError: true, truncated: true });
  expect(partial.content).toContain("Search a narrower directory.");
  const use = { id: "search", name: "grep", input: { pattern: "needle" } };
  expect(formatToolFollowup(use, done(use, partial))).toContain("incomplete (timeout)");
  expect(formatToolFollowup(use, { ...done(use, "invalid arguments", true), executed: false })).toContain("not executed");
  const command = { id: "command", name: "bash", input: { command: "exit 1" } };
  expect(formatToolFollowup(command, done(command, "[exit 1]", true))).toContain("failed");
});
