import type { ModifiedFile, ReviewDiffResult } from "../../shared/types.js";
import type { AgentTerminalInstance } from "../terminal-instance.js";
import { isErrno } from "../../shared/guards.js";
import { decodeEditorText, readEditorFile } from "./editor-file.js";

/** Canonical baseline semantics shared by regular and read-only review. */
export async function reviewBaseline(inst: Pick<AgentTerminalInstance, "baselines" | "baselineFills" | "modified">, path: string, live: () => boolean) {
  if (!inst.baselines.has(path)) {
    const pending = inst.baselineFills.get(path);
    if (pending) await pending;
  }
  if (!live()) return { status: "modified" as const, baseline: undefined };
  const status = inst.modified.get(path)?.status;
  const baseline = inst.baselines.get(path);
  if (baseline === undefined) return { status: status === "deleted" ? "deleted" as const : "modified" as const, baseline: undefined };
  if (baseline === null) return { status: "created" as const, baseline: null };
  return { status: status === "deleted" ? "deleted" as const : "modified" as const, baseline };
}

export function reviewFiles(modified: Map<string, ModifiedFile>, offset: unknown) {
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    return { ok: false as const, error: "invalid offset" };
  }
  const files: ModifiedFile[] = [];
  if (offset >= modified.size) return { ok: true as const, files, total: modified.size };
  let index = 0;
  for (const file of modified.values()) {
    if (index++ < offset) continue;
    if (files.length === 50) break;
    files.push({ ...file });
  }
  return { ok: true as const, files, total: modified.size };
}

export async function reviewDiff(inst: Pick<AgentTerminalInstance, "baselines" | "baselineFills" | "modified">, file: ModifiedFile, live: () => boolean, maxBytes: number): Promise<ReviewDiffResult> {
  try {
    const baseline = await reviewBaseline(inst, file.path, live);
    if (!live()) throw new Error("review target changed while reading");
    if (baseline.baseline === undefined) throw new Error("baseline is unavailable");
    if (baseline.baseline !== null) {
      if (Buffer.byteLength(baseline.baseline) > maxBytes) throw new Error("baseline is too large to preview");
      decodeEditorText(Buffer.from(baseline.baseline));
    }
    let current: string;
    let deleted = false;
    try {
      current = decodeEditorText(await readEditorFile(file.path, maxBytes));
    } catch (error) {
      if (!isErrno(error, "ENOENT") || file.status !== "deleted" || typeof baseline.baseline !== "string") throw error;
      current = "";
      deleted = true;
    }
    if (!live() || inst.baselines.get(file.path) !== baseline.baseline) throw new Error("review target changed while reading");
    return { ok: true, path: file.path, relPath: file.relPath, status: baseline.status, baseline: baseline.baseline, current, deleted };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "could not read review diff" };
  }
}
