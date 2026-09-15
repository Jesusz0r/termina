/**
 * Host context, ack, prompt payloads, and startup control.
 *
 * Owns ack waits, bounded context reads, protected paths, prompt
 * payloads, and startup-control consume/format. Split from
 * agent-core/host.ts (issue #38).
 */
import { errorCode, isErrno, isRecord } from "../../shared/guards.ts";
import { HAS_PLAN_TASK } from "../../shared/plan-task.ts";
import { BoundedTextAccumulator, type BoundedText, type BoundedTextMarkerDetails, type CompletionState } from "../tool-output.ts";
import { createHash, type Hash } from "node:crypto";
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";


export const ACK_ID = /^[A-Za-z0-9_-]{1,128}$/;

const CONTEXT_FILES = ["verify", "edits", "mailbox", "project", "diagnostics"] as const;

const PROTECTED_PATHS_BYTES = 64 * 1024;

const PLAN_TEXT_CAP = 4000;

export const HOST_CONTEXT_BYTES = 64 * 1024;

const HOST_CONTEXT_READ_CHUNK_BYTES = 16 * 1024;


type ReadContextFilesOptions = {
  shouldStop?: () => boolean;
};


/** Per-file attribution for one bounded host-context read.
 *
 * `size`/`mtimeMs` describe the file on disk at stat time; `consumedBytes`
 * and `contentHash` describe exactly the prefix of the file that reached the
 * overlay text (they differ from `size` when the read truncated early). A
 * `null` contentHash means no byte of that file was consumed. Comparing two
 * reads' digests pinpoints which of the five context files moved when the
 * working-set hash changes.
 */
type ContextFileDigest = Readonly<{
  kind: string;
  present: boolean;
  size: number | null;
  mtimeMs: number | null;
  consumedBytes: number;
  contentHash: string | null;
}>;


export type ContextFilesResult = BoundedText & Readonly<{
  files: readonly ContextFileDigest[];
}>;


export function ackPath(eventsDir: string, terminalId: string, requestId: string): string {
  return join(eventsDir, `ack-${terminalId}-${requestId}.json`);
}


export async function waitForAck(
  eventsDir: string,
  terminalId: string,
  requestId: string,
  timeoutMs: number,
  bridgeId: string,
  opts?: { shouldStop?: () => boolean },
): Promise<Record<string, unknown> | null> {
  if (!eventsDir || !terminalId || !ACK_ID.test(requestId) || !ACK_ID.test(terminalId)) return null;
  const target = ackPath(eventsDir, terminalId, requestId);
  const claimed = `${target}.claimed-${bridgeId}`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (opts?.shouldStop?.()) return null;
    let claimedAck = false;
    try {
      renameSync(target, claimed);
      claimedAck = true;
      try {
        const raw = readFileSync(claimed, "utf8");
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) return { ok: false, error: "malformed ack", malformed: true };
        return parsed;
      } finally {
        rmSync(claimed, { force: true });
      }
    } catch {
      // A claimed but unreadable file is corruption, not absence: fail the
      // wait promptly instead of polling to timeout like a missing ack.
      if (claimedAck) {
        try {
          rmSync(claimed, { force: true });
        } catch {
          /* best effort dead-letter removal */
        }
        return { ok: false, error: "malformed ack", malformed: true };
      }
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}


function hostContextMarker(details: BoundedTextMarkerDetails): string {
  return details.state === "complete"
    ? "[host context truncated]"
    : `[host context incomplete: ${details.state}]`;
}


function mergeContextState(current: CompletionState, next: CompletionState): CompletionState {
  if (current === "interrupted" || next === "interrupted") return "interrupted";
  if (current === "failed" || next === "failed") return "failed";
  if (current === "unreadable" || next === "unreadable") return "unreadable";
  return "complete";
}


function probeContextStop(options: ReadContextFilesOptions | undefined): "continue" | CompletionState {
  if (!options?.shouldStop) return "continue";
  try {
    return options.shouldStop() ? "interrupted" : "continue";
  } catch {
    return "failed";
  }
}


function withKnownContextInput(result: BoundedText, inputBytes: number): BoundedText {
  if (result.inputBytes === inputBytes) return result;
  return Object.freeze({
    ...result,
    inputBytes,
    omittedBytes: Math.max(0, inputBytes - result.retainedBytes),
    truncated: result.truncated || inputBytes > result.retainedBytes,
  });
}


/** Read all available host context while keeping the rendered result bounded. */
type ContextFileNote = {
  kind: (typeof CONTEXT_FILES)[number];
  present: boolean;
  size: number;
  mtimeMs: number;
  consumedBytes: number;
  hash: Hash;
};


/** Attach per-file digests to a finished bounded read. `size`/`mtimeMs`
 * describe the file on disk at stat time; `consumedBytes`/`contentHash`
 * describe exactly the prefix that reached the overlay text (they differ from
 * `size` when the read truncated early). A null contentHash means no byte of
 * that file was consumed. Comparing two reads' digests pinpoints which of the
 * five context files moved when the working-set hash changes. */
function withContextFileDigests(result: BoundedText, notes: readonly ContextFileNote[]): ContextFilesResult {
  const byKind = new Map(notes.map((note) => [note.kind, note]));
  return Object.freeze({
    ...result,
    files: Object.freeze(CONTEXT_FILES.map((kind): ContextFileDigest => {
      const note = byKind.get(kind);
      if (!note?.present) return { kind, present: false, size: null, mtimeMs: null, consumedBytes: 0, contentHash: null };
      return {
        kind,
        present: true,
        size: note.size,
        mtimeMs: note.mtimeMs,
        consumedBytes: note.consumedBytes,
        contentHash: note.consumedBytes > 0 ? note.hash.digest("hex").slice(0, 16) : null,
      };
    })),
  });
}


export function readContextFilesResult(
  eventsDir: string,
  terminalId: string,
  options?: ReadContextFilesOptions,
): ContextFilesResult {
  const accumulator = new BoundedTextAccumulator({
    maxBytes: HOST_CONTEXT_BYTES,
    direction: "head",
    marker: hostContextMarker,
  });
  const notes: ContextFileNote[] = CONTEXT_FILES.map((kind) => ({
    kind,
    present: false,
    size: 0,
    mtimeMs: 0,
    consumedBytes: 0,
    hash: createHash("sha256"),
  }));
  if (!eventsDir || !terminalId) return withContextFileDigests(accumulator.finish(), notes);

  const separator = "\n\n---\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  let state: CompletionState = "complete";
  const files: Array<{ fd: number; size: number; note: ContextFileNote }> = [];

  const closeFiles = (): void => {
    for (const file of files.splice(0)) {
      try {
        closeSync(file.fd);
      } catch {
        state = mergeContextState(state, "unreadable");
      }
    }
  };

  if (OPEN_NOFOLLOW_READ === null) return withContextFileDigests(accumulator.finish("unreadable"), notes);

  // Stat every readable context entry first. This gives the bounded reader an
  // exact remaining-byte count without scanning a multi-gigabyte file.
  const noteByKind = new Map(notes.map((note) => [note.kind, note]));
  for (const kind of CONTEXT_FILES) {
    const initialProbe = probeContextStop(options);
    if (initialProbe !== "continue") {
      state = mergeContextState(state, initialProbe);
      break;
    }

    let fd: number | undefined;
    try {
      fd = openSync(join(eventsDir, `${kind}-${terminalId}.md`), OPEN_NOFOLLOW_READ);
      const info = fstatSync(fd);
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) {
        state = mergeContextState(state, "unreadable");
        continue;
      }
      const note = noteByKind.get(kind)!;
      note.present = true;
      note.size = info.size;
      note.mtimeMs = info.mtimeMs;
      files.push({ fd, size: info.size, note });
      fd = undefined;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) state = mergeContextState(state, "unreadable");
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          state = mergeContextState(state, "unreadable");
        }
      }
    }
    if (state === "interrupted" || state === "failed") break;
  }

  if (state === "interrupted" || state === "failed") {
    closeFiles();
    return withContextFileDigests(accumulator.finish(state), notes);
  }

  let knownInputBytes = 0;
  let nonEmptyFiles = 0;
  for (const file of files) {
    if (file.size <= 0) continue;
    if (nonEmptyFiles > 0) knownInputBytes += separatorBytes;
    knownInputBytes += file.size;
    nonEmptyFiles += 1;
  }

  const needsBoundedRead = knownInputBytes > HOST_CONTEXT_BYTES;
  // Read only a few bytes beyond the output budget. The extra bytes let the
  // canonical accumulator observe omission even when the cap falls exactly on
  // a UTF-8 boundary or at the end of a context file.
  const prefixReadLimit = HOST_CONTEXT_BYTES + separatorBytes + 4;
  let streamedBytes = 0;
  let hasContent = false;

  try {
    outer: for (const file of files) {
      let fileHadBytes = false;
      let readOffset = 0;
      while (readOffset < file.size) {
        const probe = probeContextStop(options);
        if (probe !== "continue") {
          state = mergeContextState(state, probe);
          break outer;
        }
        if (needsBoundedRead && streamedBytes >= prefixReadLimit) break outer;

        if (!fileHadBytes && hasContent) {
          accumulator.push(separator);
          streamedBytes += separatorBytes;
        }
        const remainingPrefix = needsBoundedRead ? Math.max(0, prefixReadLimit - streamedBytes) : file.size - readOffset;
        if (remainingPrefix <= 0) break outer;
        const want = Math.min(HOST_CONTEXT_READ_CHUNK_BYTES, file.size - readOffset, remainingPrefix);
        const buf = Buffer.allocUnsafe(want);
        const read = readSync(file.fd, buf, 0, want, readOffset);
        if (read <= 0) {
          state = mergeContextState(state, "failed");
          break outer;
        }
        accumulator.push(buf.subarray(0, read));
        fileHadBytes = true;
        hasContent = true;
        file.note.consumedBytes += read;
        file.note.hash.update(buf.subarray(0, read));
        readOffset += read;
        streamedBytes += read;
      }

      if (state === "complete" && readOffset === file.size) {
        try {
          if (fstatSync(file.fd).size !== file.size) state = mergeContextState(state, "failed");
        } catch {
          state = mergeContextState(state, "unreadable");
        }
      }
      if (state === "interrupted" || state === "failed") break;
    }
  } finally {
    closeFiles();
  }

  const result = accumulator.finish(state);
  // The accumulator only sees the bounded prefix. For a complete read, stats
  // provide the exact source-byte total without retaining or scanning the
  // omitted suffix.
  return withContextFileDigests(state === "complete" ? withKnownContextInput(result, knownInputBytes) : result, notes);
}


/**
 * Read the machine-only Mine policy used by mutation tool gates.
 *
 * Fail-closed (#218): null when the policy cannot be established (unreadable
 * file, short read, mid-read size change, corrupt or non-array JSON,
 * oversize file, non-regular file, invalid identity). Only a missing file
 * (ENOENT) yields an empty set, meaning no policy. Callers must deny the
 * mutation on null. Platforms without O_NOFOLLOW fall back to a plain open
 * with the same fd validation; only the symlink-proofing is degraded there.
 */
export function readProtectedPaths(eventsDir: string, terminalId: string): ReadonlySet<string> | null {
  const paths = new Set<string>();
  if (!eventsDir || !ACK_ID.test(terminalId)) return null;
  const flags = OPEN_NOFOLLOW_READ === null ? "r" : OPEN_NOFOLLOW_READ;
  let fd: number | undefined;
  try {
    fd = openSync(join(eventsDir, `mine-${terminalId}.json`), flags);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= 0 || info.size > PROTECTED_PATHS_BYTES) return null;
    const data = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    if (fstatSync(fd).size !== info.size) return null;
    const parsed: unknown = JSON.parse(data.toString("utf8"));
    if (!Array.isArray(parsed)) return null;
    for (const value of parsed) {
      if (typeof value === "string" && isAbsolute(value) && value.length <= 4096) paths.add(value);
    }
  } catch (err) {
    if (errorCode(err) === "ENOENT" && fd === undefined) return new Set<string>();
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
  }
  return paths;
}


export function writePromptPayload(
  eventsDir: string,
  terminalId: string,
  fileName: string,
  payload: { prompt: string; context: string; images?: unknown[] },
): string | null {
  if (!eventsDir || !terminalId || !fileName || fileName.includes("/") || fileName.includes("\\")) return null;
  try {
    mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(eventsDir, fileName),
      JSON.stringify({ prompt: payload.prompt, images: payload.images ?? [], context: payload.context }),
      { mode: 0o600 },
    );
    return fileName;
  } catch {
    return null;
  }
}


export function promptFileName(terminalId: string, bridgeId: string, stamp: string): string {
  return `prompt-${terminalId}-${bridgeId.slice(0, 8)}-${stamp}.json`;
}


export type StartupControl = {
  opId: string;
  action: string;
  text?: string;
  content?: unknown;
};


function parseControl(raw: string): StartupControl | null {
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const obj = rec as Record<string, unknown>;
  return {
    opId: typeof obj.opId === "string" ? obj.opId : "",
    action: typeof obj.action === "string" ? obj.action : "",
    text: typeof obj.text === "string" ? obj.text : undefined,
    content: obj.content,
  };
}


function claimControlFile(path: string, bridgeId: string): StartupControl | null {
  const claimed = `${path}.claimed-${bridgeId}`;
  try {
    renameSync(path, claimed);
  } catch {
    return null;
  }
  try {
    return parseControl(readFileSync(claimed, "utf8"));
  } catch {
    return null;
  } finally {
    rmSync(claimed, { force: true });
  }
}


/** Consume startup-control-<id>.json, then startup-control.json. */
export function consumeStartupControl(
  eventsDir: string,
  terminalId: string,
  bridgeId: string,
): StartupControl | null {
  if (!eventsDir || !terminalId) return null;
  return (
    claimControlFile(join(eventsDir, `startup-control-${terminalId}.json`), bridgeId) ??
    claimControlFile(join(eventsDir, "startup-control.json"), bridgeId)
  );
}


export function structuredStartupText(control: StartupControl): string {
  if (Array.isArray(control.content)) {
    const parts: string[] = [];
    for (const item of control.content) {
      if (typeof item === "string" && item) parts.push(item);
      else if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        const text = (item as { text: string }).text;
        if (text) parts.push(text);
      }
    }
    return parts.join("\n");
  }
  return control.text ?? "";
}


export function visibleAssistantText(blocks: Array<{ type?: string; text?: string }>): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "thinking" || b.type === "reasoning" || b.type === "redacted_thinking") continue;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}


export function firstPlanText(text: string): string | null {
  if (!text.trim() || !HAS_PLAN_TASK.test(text)) return null;
  return text.slice(0, PLAN_TEXT_CAP);
}


export function planTextIfChanged(text: string, lastEmitted: string): string | null {
  const plan = firstPlanText(text);
  if (!plan || plan === lastEmitted) return null;
  return plan;
}

export const OPEN_NOFOLLOW_READ: number | null = typeof fsConstants.O_NOFOLLOW === "number"
  ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
  : null;
