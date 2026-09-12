/**
 * Host context, ack, prompt payloads, and startup control.
 *
 * Owns ack waits, bounded context reads, protected paths, prompt
 * payloads, and startup-control consume/format. Split from
 * agent-core/host.ts (issue #38).
 */
import { isErrno } from "../../shared/guards.ts";
import { HAS_PLAN_TASK } from "../../shared/plan-task.ts";
import { BoundedTextAccumulator, type BoundedText, type BoundedTextMarkerDetails, type CompletionState } from "../tool-output.ts";
import { closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";


export const ACK_ID = /^[A-Za-z0-9_-]{1,128}$/;

const CONTEXT_FILES = ["verify", "edits", "mailbox", "project", "diagnostics"] as const;

const PROTECTED_PATHS_BYTES = 64 * 1024;

const PLAN_TEXT_CAP = 4000;

export const HOST_CONTEXT_BYTES = 64 * 1024;

const HOST_CONTEXT_READ_CHUNK_BYTES = 16 * 1024;


export type ReadContextFilesOptions = {
  shouldStop?: () => boolean;
};


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
    try {
      renameSync(target, claimed);
      try {
        const raw = readFileSync(claimed, "utf8");
        return JSON.parse(raw) as Record<string, unknown>;
      } finally {
        rmSync(claimed, { force: true });
      }
    } catch {
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
export function readContextFilesResult(
  eventsDir: string,
  terminalId: string,
  options?: ReadContextFilesOptions,
): BoundedText {
  const accumulator = new BoundedTextAccumulator({
    maxBytes: HOST_CONTEXT_BYTES,
    direction: "head",
    marker: hostContextMarker,
  });
  if (!eventsDir || !terminalId) return accumulator.finish();

  const separator = "\n\n---\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  let state: CompletionState = "complete";
  const files: Array<{ fd: number; size: number }> = [];

  const closeFiles = (): void => {
    for (const file of files.splice(0)) {
      try {
        closeSync(file.fd);
      } catch {
        state = mergeContextState(state, "unreadable");
      }
    }
  };

  if (OPEN_NOFOLLOW_READ === null) return accumulator.finish("unreadable");

  // Stat every readable context entry first. This gives the bounded reader an
  // exact remaining-byte count without scanning a multi-gigabyte file.
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
      files.push({ fd, size: info.size });
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
    return accumulator.finish(state);
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
  return state === "complete" ? withKnownContextInput(result, knownInputBytes) : result;
}


/** Existing bridge contract: callers that only need text get the bounded view. */
export function readContextFiles(eventsDir: string, terminalId: string): string {
  return readContextFilesResult(eventsDir, terminalId).text;
}


/** Read the machine-only Mine policy used by mutation tool gates. */
export function readProtectedPaths(eventsDir: string, terminalId: string): ReadonlySet<string> {
  const paths = new Set<string>();
  if (!eventsDir || !ACK_ID.test(terminalId) || OPEN_NOFOLLOW_READ === null) return paths;
  let fd: number | undefined;
  try {
    fd = openSync(join(eventsDir, `mine-${terminalId}.json`), OPEN_NOFOLLOW_READ);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= 0 || info.size > PROTECTED_PATHS_BYTES) return paths;
    const data = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (count <= 0) return new Set();
      offset += count;
    }
    if (fstatSync(fd).size !== info.size) return new Set();
    const parsed = JSON.parse(data.toString("utf8"));
    if (!Array.isArray(parsed)) return paths;
    for (const value of parsed) {
      if (typeof value === "string" && isAbsolute(value) && value.length <= 4096) paths.add(value);
    }
  } catch {
    return new Set();
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
