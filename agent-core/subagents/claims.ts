/**
 * Live sibling-claim enforcement.
 *
 * The host publishes one claims file per parent terminal whenever the live
 * set changes. File tools refuse an overlapping path. Bash on macOS runs
 * under sandbox-exec with those paths write-denied; anywhere that cannot
 * enforce the deny fails closed instead of pretending the prompt is a lock.
 */
import { existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readBoundedRegularFile } from "../main/files.ts";
import { MAX_SUBAGENT_CLAIM_PATHS, MAX_SUBAGENT_FILE_BYTES, subagentPathsOverlap } from "../subagents.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface SubagentClaimSet {
  runId: string;
  paths: string[];
}

export function subagentClaimsFileName(parentTerminalId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(parentTerminalId)) return null;
  return `subagent-${parentTerminalId}.claims.json`;
}

function atomicWriteJsonSync(dir: string, name: string, body: string): boolean {
  try {
    const target = join(dir, name);
    const temp = `${target}.${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}.tmp`;
    writeFileSync(temp, body, { mode: 0o600 });
    renameSync(temp, target);
    return true;
  } catch {
    return false;
  }
}

export function writeSubagentClaimsFile(
  eventsDir: string,
  parentTerminalId: string,
  runs: readonly SubagentClaimSet[],
): boolean {
  const name = subagentClaimsFileName(parentTerminalId);
  if (!name || !eventsDir) return false;
  const body = JSON.stringify({
    version: 1,
    runs: runs.map((run) => ({ runId: run.runId, paths: run.paths.slice(0, MAX_SUBAGENT_CLAIM_PATHS) })),
  });
  return atomicWriteJsonSync(eventsDir, name, body);
}

export type SubagentClaimsRead =
  | { status: "missing" }
  | { status: "invalid"; error: string }
  | { status: "ok"; runs: SubagentClaimSet[] };

export function readSubagentClaimsFile(eventsDir: string, parentTerminalId: string): SubagentClaimsRead {
  const name = subagentClaimsFileName(parentTerminalId);
  if (!name || !eventsDir) return { status: "missing" };
  const bounded = readBoundedRegularFile(join(eventsDir, name), MAX_SUBAGENT_FILE_BYTES);
  if ("error" in bounded) {
    if (bounded.error.includes("ENOENT")) return { status: "missing" };
    return { status: "invalid", error: "claim manifest is unreadable" };
  }
  if (bounded.truncated) return { status: "invalid", error: "claim manifest exceeds its file budget" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded.text);
  } catch {
    return { status: "invalid", error: "claim manifest is not JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "invalid", error: "claim manifest is not an object" };
  }
  const v = parsed as Record<string, unknown>;
  if (v.version !== 1 || !Array.isArray(v.runs)) return { status: "invalid", error: "claim manifest is malformed" };
  const runs: SubagentClaimSet[] = [];
  for (const entry of v.runs) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { status: "invalid", error: "claim manifest has a bad run" };
    const row = entry as Record<string, unknown>;
    if (typeof row.runId !== "string" || !Array.isArray(row.paths) || row.paths.some((p) => typeof p !== "string")) {
      return { status: "invalid", error: "claim manifest has a bad run" };
    }
    runs.push({ runId: row.runId, paths: row.paths as string[] });
  }
  return { status: "ok", runs };
}

function canonicalClaim(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function siblingPaths(runs: readonly SubagentClaimSet[], selfRunId: string | null): string[] {
  const out: string[] = [];
  for (const run of runs) {
    if (selfRunId && run.runId === selfRunId) continue;
    for (const path of run.paths) if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

/** Error when a mutation overlaps another live run's claim. Null means allowed. */
export function subagentMutationBlock(
  eventsDir: string,
  parentTerminalId: string,
  selfRunId: string | null,
  absPath: string,
): string | null {
  const read = readSubagentClaimsFile(eventsDir, parentTerminalId);
  // Missing means the host has not published a live set. That is "no sibling
  // claims", not an unreadable lock. A malformed file is the fail-closed case.
  if (read.status === "missing") return null;
  if (read.status === "invalid") return `error: ${read.error}; write refused`;
  const target = canonicalClaim(absPath);
  const hit = siblingPaths(read.runs, selfRunId)
    .map(canonicalClaim)
    .find((claim) => subagentPathsOverlap(target, claim));
  if (!hit) return null;
  return `error: path overlaps a sibling subagent claim (${hit})`;
}

function sandboxPath(path: string): string | null {
  if (!isAbsolute(path) || /[\0-\x1f"\\]/.test(path)) return null;
  return path;
}

/**
 * macOS write-deny profile for sibling claims, or an error when the platform
 * cannot enforce it. Null means there is nothing to deny.
 */
export function subagentBashSandbox(
  eventsDir: string,
  parentTerminalId: string,
  selfRunId: string | null,
): { profile: string } | { error: string } | null {
  const read = readSubagentClaimsFile(eventsDir, parentTerminalId);
  if (read.status === "missing") return null;
  if (read.status === "invalid") return { error: `error: ${read.error}; bash refused` };
  const paths = siblingPaths(read.runs, selfRunId).map(canonicalClaim);
  if (paths.length === 0) return null;
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) {
    return { error: "error: bash cannot be isolated from sibling claims on this platform" };
  }
  const rules: string[] = ["(version 1)", "(allow default)"];
  for (const path of paths) {
    const safe = sandboxPath(path);
    if (!safe) return { error: "error: a sibling claim path cannot be expressed in the sandbox profile; bash refused" };
    rules.push(`(deny file-write* (subpath ${JSON.stringify(safe)}))`);
  }
  return { profile: rules.join("\n") };
}

/** Tools that can write anywhere (MCP) cannot be proven clear of a sibling claim. */
export function subagentUnconfinedToolBlock(
  eventsDir: string,
  parentTerminalId: string,
  selfRunId: string | null,
): string | null {
  const read = readSubagentClaimsFile(eventsDir, parentTerminalId);
  if (read.status === "missing") return null;
  if (read.status === "invalid") return `error: ${read.error}; tool refused`;
  if (siblingPaths(read.runs, selfRunId).length === 0) return null;
  return "error: this tool cannot be isolated from sibling subagent claims";
}
