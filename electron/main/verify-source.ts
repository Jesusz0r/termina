import { isAbsolute } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { VERIFY_RESULT_STATES, type VerifyInfo, type VerifySource } from "../../shared/types.ts";

export function isVerifySourceCurrent(tested: VerifySource | undefined, current: VerifySource | undefined): boolean {
  return !!tested && !!current && tested.workspaceId === current.workspaceId && tested.root === current.root
    && tested.tree === current.tree && tested.revision === current.revision && tested.observationEpoch === current.observationEpoch
    && tested.generation === current.generation;
}

export function invalidateVerify(verify: VerifyInfo, reason: string): VerifyInfo {
  if (verify.state === "untested" || verify.state === "running" || verify.state === "stale") return verify;
  return { ...verify, state: "stale", summary: `outdated · ${verify.summary ?? verify.state}`, staleReason: reason };
}

const safeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, limit: number): string | null =>
  typeof value === "string" && value.length <= limit && !/[\x00-\x1f]/.test(value) ? value : null;

/** The roster is an external disk boundary; malformed metadata is not evidence. */
export function parseStoredVerify(value: unknown): VerifyInfo | undefined {
  if (!isRecord(value)) return undefined;
  const state = value.state === "stale" ? "stale" : VERIFY_RESULT_STATES.find((state) => state === value.state);
  if (!state) return undefined;
  const verify: VerifyInfo = { state, command: text(value.command, 256), summary: text(value.summary, 256) };
  const source = isRecord(value.source) ? value.source : null;
  const root = text(source?.root, 4096);
  const workspaceId = text(source?.workspaceId, 100);
  if (source && root && isAbsolute(root) && workspaceId && typeof source.tree === "string"
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.tree) && safeInt(source.revision) && safeInt(source.observationEpoch) && safeInt(source.generation)) {
    verify.source = { root, workspaceId, tree: source.tree, revision: source.revision, observationEpoch: source.observationEpoch, generation: source.generation };
  }
  const result = isRecord(value.result) ? value.result : null;
  const resultState = VERIFY_RESULT_STATES.find((state) => state === result?.state);
  if (result && resultState && (result.exitCode === null || (typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode)))
    && safeInt(result.startedAt) && safeInt(result.finishedAt) && result.finishedAt >= result.startedAt && result.finishedAt <= 8_640_000_000_000_000) {
    verify.result = { state: resultState, exitCode: result.exitCode as number | null, startedAt: result.startedAt, finishedAt: result.finishedAt };
  }
  const reason = text(value.staleReason, 500);
  if (reason) verify.staleReason = reason;
  return verify;
}

export function parseStoredVerifyOutput(value: unknown): string | undefined {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 6000 ? value : undefined;
}

export function verifyOutputTail(output: string): string {
  const bytes = Buffer.from(output.trim(), "utf8");
  let start = Math.max(0, bytes.length - 6000);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString("utf8");
}

export function formatVerifyContext(verify: VerifyInfo, output: string | null, failed?: { count: number; names: string[] } | null): string {
  const status = (state: VerifyInfo["state"]): string => state === "pass" ? "✅ PASSED" : state === "timeout" ? "⏰ TIMED OUT"
    : state === "cancelled" ? "CANCELLED" : state === "stale" ? "⚠️ OUTDATED"
    : state === "running" ? "RUNNING" : state === "untested" ? "NOT RUN" : "❌ FAILED";
  const result = verify.result;
  const exit = result?.exitCode !== null && result?.exitCode !== undefined ? ` (exit code ${result.exitCode})` : "";
  const body = verifyOutputTail(output ?? "");
  return `## Test run — \`${verify.command ?? "unknown"}\` — ${result ? new Date(result.finishedAt).toISOString() : verify.state === "untested" ? "not run" : "previous session"}\n\n`
    + `**Status:** ${status(verify.state)}${verify.state === "stale" ? "" : exit}\n\n`
    + (verify.staleReason ? `**Validity:** ${verify.staleReason}\n\n` : "")
    + (verify.state === "stale" && result ? `**Historical execution:** ${status(result.state)}${exit}\n\n` : "")
    + (result ? `**Started:** ${new Date(result.startedAt).toISOString()}\n**Finished:** ${new Date(result.finishedAt).toISOString()}\n**Elapsed:** ${result.finishedAt - result.startedAt} ms\n\n` : "")
    + (verify.source ? `**Source scope:** tracked and non-ignored untracked workspace files\n**Workspace:** ${JSON.stringify(verify.source.root)}\n**Tree:** ${verify.source.tree}\n\n` : "**Source:** unavailable\n\n")
    + (failed && failed.count > 0 ? `**Failed:** ${failed.count} — ${failed.names.map((name) => `\`${name}\``).join(", ")}\n\n` : "")
    + (output === null && verify.state !== "untested" ? "**Output:** not retained for this historical run\n\n" : "")
    + (body ? `<details>\n<summary>Output (bounded tail)</summary>\n\n\`\`\`text\n${body}\n\`\`\`\n</details>\n` : "");
}
