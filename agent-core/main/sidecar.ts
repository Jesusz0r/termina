/**
 * Sidecar producer: bounded edit previews, trace-dir naming, and the durable
 * FIFO event writer (backpressure/quarantine/seal/rotation). One writer per
 * process; all writer state lives in the factory closure.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { syncParentDir } from "../../shared/fsync.ts";

export function isValidTerminalId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** Keep producer edit previews below the tailer's durable record limit. The
 * tool boundary and a digest/count remain even when the preview is clipped;
 * the file on disk remains the authority for the state mutation. */
export const SIDECAR_TOOL_EDIT_PREVIEW_BYTES = 512 * 1024;
const SIDECAR_TOOL_EDIT_FIELD_BYTES = 128 * 1024;

function utf8Prefix(value: string, maxBytes: number): string {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (source[end]! & 0xc0) === 0x80) end--;
  return source.subarray(0, end).toString("utf8");
}

export function boundedSidecarEdits(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const edits: Array<Record<string, string>> = [];
  let retainedBytes = 2;
  let editsTruncated = false;
  for (const item of value) {
    if (!item || typeof item !== "object") {
      editsTruncated = true;
      continue;
    }
    const rec = item as Record<string, unknown>;
    const oldText = typeof rec.oldText === "string" ? rec.oldText : typeof rec.old_text === "string" ? rec.old_text : undefined;
    const newText = typeof rec.newText === "string" ? rec.newText : typeof rec.new_text === "string" ? rec.new_text : undefined;
    if (oldText === undefined && newText === undefined) {
      editsTruncated = true;
      continue;
    }
    const preview: Record<string, string> = {};
    if (oldText !== undefined) {
      preview.oldText = utf8Prefix(oldText, SIDECAR_TOOL_EDIT_FIELD_BYTES);
      if (preview.oldText !== oldText) editsTruncated = true;
    }
    if (newText !== undefined) {
      preview.newText = utf8Prefix(newText, SIDECAR_TOOL_EDIT_FIELD_BYTES);
      if (preview.newText !== newText) editsTruncated = true;
    }
    const candidateBytes = Buffer.byteLength(JSON.stringify(preview), "utf8") + (edits.length === 0 ? 0 : 1);
    if (retainedBytes + candidateBytes > SIDECAR_TOOL_EDIT_PREVIEW_BYTES) {
      editsTruncated = true;
      break;
    }
    edits.push(preview);
    retainedBytes += candidateBytes;
  }
  if (edits.length < value.length) editsTruncated = true;
  if (!editsTruncated) return edits.length > 0 ? { edits } : {};
  // Only serialize the full edit list when callers actually need the
  // truncation boundary (bytes/count/sha). The common fitting case skips it.
  const serialized = JSON.stringify(value) ?? "[]";
  const encoded = Buffer.from(serialized, "utf8");
  return {
    ...(edits.length > 0 ? { edits } : {}),
    editsTruncated: true,
    editsBytes: encoded.length,
    editsCount: value.length,
    editsSha256: createHash("sha256").update(encoded).digest("hex"),
  };
}

export function tracesDirFor(events: string, id: string): string | null {
  if (!events || !isValidTerminalId(id)) return null;
  return join(events, `${id}.traces`);
}

const SIDECAR_MAX_BYTES = 8 * 1024 * 1024;
const SIDECAR_SEALED_SUFFIX = ".sealed";
const SIDECAR_SEALED_PROOF_SUFFIX = ".owner";
const SIDECAR_QUARANTINE_PREFIX = ".quarantine-";
const SIDECAR_MAX_BACKPRESSURE_POLLS = 80;
const SIDECAR_APPEND_RETRY_MS = 25;
const SIDECAR_MAX_APPEND_RETRIES = 80;
const SIDECAR_MAX_PENDING_EVENTS = 256;
/** Idempotency look-behind for sidecar appends. Dup detection only matters
 * at EOF (see appendDurable); the window beyond one payload length exists
 * solely for interleaved foreign bytes. */
const SIDECAR_DUP_WINDOW_BYTES = 64 * 1024;

type PendingSidecarWrite = {
  body: Record<string, unknown>;
  seq: number;
  generation: string | null;
  line: string | null;
  attempts: number;
};

export interface SidecarWriter {
  logEvent: (body: Record<string, unknown>) => void;
  isWriteStopped: () => boolean;
}

export function createSidecarWriter(opts: { eventsDir: string; terminalId: string; bridgeId: string }): SidecarWriter {
  const { eventsDir, terminalId, bridgeId } = opts;
  let seq = 0;
  // Every record carries the immutable generation of the producer-owned
  // inode. A marker without this binding cannot authorize retirement.
  let writerGeneration = randomUUID();
  const sidecarBackpressureCell = new Int32Array(new SharedArrayBuffer(4));
  const activeSidecarPath = eventsDir && terminalId ? join(eventsDir, terminalId + ".jsonl") : "";
  let sidecarWriteStopped = false;
  const pendingSidecarWrites: PendingSidecarWrite[] = [];
  let sidecarRetryTimer: ReturnType<typeof setTimeout> | null = null;

  function syncFile(path: string): void {
    const fd = openSync(path, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  function writeDurableMarker(path: string, content: string): void {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
      syncFile(temp);
      renameSync(temp, path);
      syncParentDir(path);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  }
  function waitForSidecarBackpressure(): boolean {
    if (!eventsDir || !terminalId) return true;
    const marker = join(eventsDir, `.backpressure-${terminalId}`);
    let polls = 0;
    while (existsSync(marker)) {
      if (hasQuarantineSidecar()) return false;
      if (++polls > SIDECAR_MAX_BACKPRESSURE_POLLS) {
        // Checkpoint/preflight handlers can outlive this poll budget. Treat
        // the marker as advisory so a slow consumer cannot quarantine the
        // producer and permanently stall the terminal.
        return true;
      }
      try {
        Atomics.wait(sidecarBackpressureCell, 0, 0, 25);
      } catch {
        // A runtime that cannot block synchronously must fail closed rather
        // than append past the bounded durable spool.
        return false;
      }
    }
    return true;
  }
  function hasQuarantineSidecar(): boolean {
    return !!eventsDir && !!terminalId && existsSync(join(eventsDir, SIDECAR_QUARANTINE_PREFIX + terminalId));
  }
  function hasRetainedSidecar(): boolean {
    if (!eventsDir || !terminalId) return false;
    try {
      const prefix = "." + terminalId + ".jsonl.";
      return readdirSync(eventsDir).some((name) =>
        name.startsWith(prefix)
        && (name.includes(".retained-")
          || name.includes(".draining-")
          || name.includes(".final-"))
      );
    } catch {
      return false;
    }
  }
  function quarantineAdmission(reason: string): void {
    try {
      if (!hasQuarantineSidecar()) {
        writeDurableMarker(
          join(eventsDir, SIDECAR_QUARANTINE_PREFIX + terminalId),
          JSON.stringify({ version: 1, state: "quarantined", terminalId, reason }) + "\n",
        );
      }
    } catch {
      /* The caller still fails closed if the diagnostic cannot be published. */
    }
  }
  /** Append one exact record idempotently. If a write/fsync throws after the
   * kernel accepted the bytes, the next attempt recognizes that same line and
   * only commits its reserved sequence once durability succeeds. */
  function appendDurable(path: string, line: string): void {
    const payload = Buffer.from(line, "utf8");
    const fd = openSync(path, "a+", 0o600);
    try {
      const size = fstatSync(fd).size;
      // The writer is a single FIFO, so a retried line is always at (or
      // partially at) EOF: one payload length covers the full-duplicate check
      // and the longest recoverable prefix. The extra window only absorbs
      // interleaved foreign bytes; a full-file scan would re-read megabytes
      // per tool event for no additional safety.
      const tailSize = Math.min(size, payload.length + SIDECAR_DUP_WINDOW_BYTES);
      const tail = Buffer.alloc(tailSize);
      if (tailSize > 0) readSync(fd, tail, 0, tailSize, size - tailSize);
      if (tail.indexOf(payload) < 0) {
        // Recover a prefix accepted by a failed write without emitting the
        // pending identity a second time. O_APPEND keeps each syscall at EOF.
        let prefix = 0;
        const maxPrefix = Math.min(payload.length - 1, tail.length);
        for (let length = maxPrefix; length > 0; length--) {
          let equal = true;
          const start = tail.length - length;
          for (let i = 0; i < length; i++) {
            if (tail[start + i] !== payload[i]) { equal = false; break; }
          }
          if (equal) { prefix = length; break; }
        }
        let written = prefix;
        while (written < payload.length) {
          const count = writeSync(fd, payload, written, payload.length - written, undefined);
          if (!Number.isInteger(count) || count <= 0) throw new Error("sidecar append made no progress");
          written += count;
        }
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  /** Publish a sealed generation from the producer side. Publication records
   * the active inode identity and durable close state; the tailer will not trust
   * a marker that is merely present or bound to another generation. */
  function sealBeforeAppend(lineBytes: number, lastSeq: number): boolean {
    if (!activeSidecarPath) return false;
    if (hasQuarantineSidecar()) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let activeStats: ReturnType<typeof statSync>;
      try {
        activeStats = statSync(activeSidecarPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          try {
            const activeFd = openSync(activeSidecarPath, "a", 0o600);
            try { fsyncSync(activeFd); } finally { closeSync(activeFd); }
            syncParentDir(activeSidecarPath);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      }
      if (activeStats.size === 0 || activeStats.size + lineBytes <= SIDECAR_MAX_BYTES) return true;
      // A retained/unproven inode may continue draining while this active
      // generation has room. Once rotation is required, admission stops at
      // the bounded quarantine boundary instead of creating an overtaking
      // generation that could lose sequence order.
      if (hasRetainedSidecar()) {
        quarantineAdmission("unproven sidecar generation blocked a safe rotation");
        return false;
      }
      // Let an already-published canonical generation retire before creating
      // another one. This wait is only on the rotation boundary; ordinary
      // active appends continue while an older retained inode drains.
      let sealedPolls = 0;
      let sealedPending = false;
      try {
        const prefix = "." + terminalId + ".jsonl.";
        sealedPending = readdirSync(eventsDir).some((name) => name.startsWith(prefix) && name.endsWith(SIDECAR_SEALED_SUFFIX));
      } catch {}
      while (sealedPending) {
        if (++sealedPolls > SIDECAR_MAX_BACKPRESSURE_POLLS) {
          quarantineAdmission("sealed sidecar generation did not retire within the bounded admission budget");
          return false;
        }
        if (!waitForSidecarBackpressure()) return false;
        try { Atomics.wait(sidecarBackpressureCell, 0, 0, 25); } catch { return false; }
        if (hasQuarantineSidecar()) return false;
        if (hasRetainedSidecar()) {
          quarantineAdmission("unproven sidecar generation blocked a safe rotation");
          return false;
        }
        try {
          const prefix = "." + terminalId + ".jsonl.";
          sealedPending = readdirSync(eventsDir).some((name) => name.startsWith(prefix) && name.endsWith(SIDECAR_SEALED_SUFFIX));
        } catch {
          sealedPending = false;
        }
      }
      let proofPath: string | undefined;
      try {
        const sealedPath = activeSidecarPath + "." + Date.now().toString(36) + "-" + process.pid + "-" + randomUUID() + SIDECAR_SEALED_SUFFIX;
        proofPath = sealedPath + SIDECAR_SEALED_PROOF_SUFFIX;
        const sealedName = basename(sealedPath);
        const identity = String(activeStats.dev) + ":" + String(activeStats.ino);
        // The synchronous append path has no descriptor that survives this
        // call. Flush and revalidate the active inode immediately before the
        // publication boundary; a concurrent replacement must not be described
        // by this writer's close proof.
        syncFile(activeSidecarPath);
        const beforeRename = statSync(activeSidecarPath);
        if (String(beforeRename.dev) + ":" + String(beforeRename.ino) !== identity || beforeRename.size !== activeStats.size) continue;
        renameSync(activeSidecarPath, sealedPath);
        syncFile(sealedPath);
        const activeFd = openSync(activeSidecarPath, "a", 0o600);
        try { fsyncSync(activeFd); } finally { closeSync(activeFd); }
        syncParentDir(sealedPath);
        // Publish the close proof last. If a crash interrupts any prior
        // rename/file/parent durability step, restart sees an unproven sealed
        // inode and keeps an anchor instead of trusting an orphan marker.
        writeDurableMarker(proofPath, JSON.stringify({
          version: 2,
          state: "closed",
          writerId: bridgeId,
          bridgeId,
          generation: writerGeneration,
          sealedName,
          identity,
          lastSeq,
        }) + "\n");
        writerGeneration = randomUUID();
        return true;
      } catch (error) {
        // A failed publish may have written a proof after the sealed pathname
        // was published but before the complete operation returned. Removing
        // it makes restart use the conservative retained-anchor path.
        if (proofPath) {
          try {
            rmSync(proofPath, { force: true });
            syncParentDir(proofPath);
          } catch { /* best effort */ }
        }
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        return false;
      }
    }
    return false;
  }
  function scheduleSidecarRetry(): void {
    if (sidecarWriteStopped || sidecarRetryTimer !== null) return;
    sidecarRetryTimer = setTimeout(() => {
      sidecarRetryTimer = null;
      // The queue head may have committed while this timer was pending; retry
      // whichever exact identity is now blocking the FIFO.
      flushPendingSidecar();
    }, SIDECAR_APPEND_RETRY_MS);
  }
  function failPendingSidecar(pending: PendingSidecarWrite, error: unknown): void {
    pending.attempts++;
    if (pending.attempts >= SIDECAR_MAX_APPEND_RETRIES) {
      sidecarWriteStopped = true;
      quarantineAdmission("sidecar append did not become durable within the bounded retry budget");
      console.warn(`[sidecar] event append stopped after bounded retries: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    scheduleSidecarRetry();
  }
  function flushPendingSidecar(): boolean {
    if (pendingSidecarWrites.length === 0 || sidecarWriteStopped) return false;
    while (pendingSidecarWrites.length > 0) {
      const pending = pendingSidecarWrites[0]!;
      try {
        mkdirSync(eventsDir, { recursive: true });
        if (!waitForSidecarBackpressure()) throw new Error("sidecar admission is paused");
        if (pending.line === null) {
          const draft = JSON.stringify({ ...pending.body, bridgeId, producerPid: process.pid, seq: pending.seq, generation: writerGeneration }) + "\n";
          if (!sealBeforeAppend(Buffer.byteLength(draft, "utf8"), seq)) throw new Error("sidecar generation is not publishable");
          // Rotation changes the active inode generation. Freeze the post-rotation
          // line so every retry addresses this exact event identity.
          pending.generation = writerGeneration;
          pending.line = JSON.stringify({ ...pending.body, bridgeId, producerPid: process.pid, seq: pending.seq, generation: pending.generation }) + "\n";
        }
        appendDurable(activeSidecarPath, pending.line);
        // The sequence is committed only after append + fsync succeed.
        seq = pending.seq;
        pendingSidecarWrites.shift();
        pending.attempts = 0;
      } catch (error) {
        failPendingSidecar(pending, error);
        return false;
      }
    }
    return true;
  }
  function logEvent(body: Record<string, unknown>): void {
    if (!eventsDir || !terminalId || sidecarWriteStopped) return;
    // Reserve in call order even while an earlier append is retrying. Later
    // records stay queued behind the exact failed identity instead of being
    // silently dropped by a transient filesystem error.
    if (pendingSidecarWrites.length >= SIDECAR_MAX_PENDING_EVENTS) {
      sidecarWriteStopped = true;
      quarantineAdmission("sidecar pending event queue exceeded its bounded admission");
      console.warn("[sidecar] event append stopped after pending queue overflow");
      return;
    }
    pendingSidecarWrites.push({ body, seq: seq + pendingSidecarWrites.length + 1, generation: null, line: null, attempts: 0 });
    void flushPendingSidecar();
  }
  return { logEvent, isWriteStopped: () => sidecarWriteStopped };
}
