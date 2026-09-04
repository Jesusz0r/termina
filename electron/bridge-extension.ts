/**
 * The Termina bridge extension source.
 *
 * Pi loads this file through the CLI extension option. agent-core writes
 * the same sidecar protocol. `electron/sidecar.ts` is the only parser.
 */
import { HAS_PLAN_TASK } from "./plan-board.js";

export const BRIDGE_EXTENSION = `
/**
 * Termina bridge extension — auto-generated, do not edit.
 */
import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FILE_TOOLS = new Set(["write", "edit", "apply_patch", "create_file", "insert"]);
const SIDECAR_TOOL_EDIT_PREVIEW_BYTES = 512 * 1024;
const SIDECAR_TOOL_EDIT_FIELD_BYTES = 128 * 1024;
const SIDECAR_MAX_BYTES = 8 * 1024 * 1024;
const SIDECAR_SEALED_SUFFIX = ".sealed";
const SIDECAR_SEALED_PROOF_SUFFIX = ".owner";
const SIDECAR_QUARANTINE_PREFIX = ".quarantine-";
const SIDECAR_MAX_BACKPRESSURE_POLLS = 80;
const SIDECAR_APPEND_RETRY_MS = 25;
const SIDECAR_MAX_APPEND_RETRIES = 80;
const SIDECAR_MAX_PENDING_EVENTS = 256;

function syncFile(path) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(path) {
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurableMarker(path, content) {
  const temp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
    syncFile(temp);
    renameSync(temp, path);
    syncDirectory(path);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function utf8Prefix(value, maxBytes) {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (source[end] & 0xc0) === 0x80) end--;
  return source.subarray(0, end).toString("utf8");
}

function boundedSidecarEdits(value) {
  if (!Array.isArray(value)) return undefined;
  const serialized = JSON.stringify(value) || "[]";
  const editsBytes = Buffer.byteLength(serialized, "utf8");
  const editsSha256 = createHash("sha256").update(serialized, "utf8").digest("hex");
  const edits = [];
  let retainedBytes = 2;
  let editsTruncated = false;
  for (const item of value) {
    if (!item || typeof item !== "object") {
      editsTruncated = true;
      continue;
    }
    const oldText = typeof item.oldText === "string" ? item.oldText : typeof item.old_text === "string" ? item.old_text : undefined;
    const newText = typeof item.newText === "string" ? item.newText : typeof item.new_text === "string" ? item.new_text : undefined;
    if (oldText === undefined && newText === undefined) {
      editsTruncated = true;
      continue;
    }
    const preview = {};
    if (oldText !== undefined) {
      preview.oldText = utf8Prefix(oldText, SIDECAR_TOOL_EDIT_FIELD_BYTES);
      if (Buffer.byteLength(preview.oldText, "utf8") !== Buffer.byteLength(oldText, "utf8")) editsTruncated = true;
    }
    if (newText !== undefined) {
      preview.newText = utf8Prefix(newText, SIDECAR_TOOL_EDIT_FIELD_BYTES);
      if (Buffer.byteLength(preview.newText, "utf8") !== Buffer.byteLength(newText, "utf8")) editsTruncated = true;
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
  return {
    ...(edits.length > 0 ? { edits } : {}),
    ...(editsTruncated ? { editsTruncated: true, editsBytes, editsCount: value.length, editsSha256 } : {}),
  };
}


export default function (pi: ExtensionAPI): void {
  const dir = process.env.TERMINA_EVENTS_DIR;
  const id = process.env.TERMINA_TERMINAL_ID;
  if (!dir || !id) return;
  // One random bridge instance id per extension load. Main accepts a
  // sequence reset only after a new instance id (WORLDLINES §6.3).
  const bridgeId = randomUUID();
  let seq = 0;
  // Every record carries the immutable generation of the producer-owned
  // inode. A marker without this binding cannot authorize retirement.
  let writerGeneration = randomUUID();
  const sidecarBackpressureCell = new Int32Array(new SharedArrayBuffer(4));
  const waitForSidecarBackpressure = (): boolean => {
    const marker = join(dir, ".backpressure-" + id);
    let polls = 0;
    while (existsSync(marker)) {
      if (hasQuarantineSidecar()) return false;
      if (++polls > SIDECAR_MAX_BACKPRESSURE_POLLS) {
        return true;
      }
      try {
        Atomics.wait(sidecarBackpressureCell, 0, 0, 25);
      } catch {
        // Fail closed if this runtime cannot block; never append past the
        // bounded durable spool after admission has been paused.
        return false;
      }
    }
    return true;
  };
  const activeSidecarPath = join(dir, id + ".jsonl");
  const hasQuarantineSidecar = (): boolean => existsSync(join(dir, SIDECAR_QUARANTINE_PREFIX + id));
  const hasRetainedSidecar = (): boolean => {
    try {
      const prefix = "." + id + ".jsonl.";
      return readdirSync(dir).some((name) =>
        name.startsWith(prefix)
        && (name.includes(".retained-")
          || name.includes(".draining-")
          || name.includes(".final-"))
      );
    } catch {
      return false;
    }
  };
  const quarantineAdmission = (reason) => {
    try {
      if (!hasQuarantineSidecar()) {
        writeDurableMarker(
          join(dir, SIDECAR_QUARANTINE_PREFIX + id),
          JSON.stringify({ version: 1, state: "quarantined", terminalId: id, reason }) + "\\n",
        );
      }
    } catch {}
  };
  // A failed fsync can happen after the kernel accepted the bytes. Reopen the
  // same active inode and recognize the exact record before retrying, so a
  // reserve/commit retry never appends a duplicate line.
  const appendDurable = (path, line) => {
    const payload = Buffer.from(line, "utf8");
    const fd = openSync(path, "a+", 0o600);
    try {
      const size = fstatSync(fd).size;
      const tailSize = Math.min(size, SIDECAR_MAX_BYTES + payload.length);
      const tail = Buffer.alloc(tailSize);
      if (tailSize > 0) readSync(fd, tail, 0, tailSize, size - tailSize);
      if (tail.indexOf(payload) < 0) {
        // Recover a partial write from the same pending identity. O_APPEND
        // makes each write atomic; the suffix check is only for a write that
        // returned an error after accepting a prefix.
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
  };
  /** Rotate only from the canonical producer. Publication records the active
   * inode identity and durable close state; the tailer will not trust a
   * marker that is merely present or bound to another generation. */
  const sealBeforeAppend = (lineBytes, lastSeq) => {
    if (hasQuarantineSidecar()) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let activeStats;
      try {
        activeStats = statSync(activeSidecarPath);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          try {
            const activeFd = openSync(activeSidecarPath, "a", 0o600);
            try { fsyncSync(activeFd); } finally { closeSync(activeFd); }
            syncDirectory(activeSidecarPath);
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
        const prefix = "." + id + ".jsonl.";
        sealedPending = readdirSync(dir).some((name) => name.startsWith(prefix) && name.endsWith(SIDECAR_SEALED_SUFFIX));
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
          const prefix = "." + id + ".jsonl.";
          sealedPending = readdirSync(dir).some((name) => name.startsWith(prefix) && name.endsWith(SIDECAR_SEALED_SUFFIX));
        } catch {
          sealedPending = false;
        }
      }
      let proofPath;
      try {
        const sealedPath = activeSidecarPath + "." + Date.now().toString(36) + "-" + process.pid + "-" + randomUUID() + SIDECAR_SEALED_SUFFIX;
        proofPath = sealedPath + SIDECAR_SEALED_PROOF_SUFFIX;
        const sealedName = basename(sealedPath);
        const identity = String(activeStats.dev) + ":" + String(activeStats.ino);
        // The synchronous append path has no descriptor that survives this
        // call. Flush and revalidate the active inode immediately before the
        // publication boundary; a concurrent legacy replacement must not be
        // described by this writer's close proof.
        syncFile(activeSidecarPath);
        const beforeRename = statSync(activeSidecarPath);
        if (String(beforeRename.dev) + ":" + String(beforeRename.ino) !== identity || beforeRename.size !== activeStats.size) continue;
        renameSync(activeSidecarPath, sealedPath);
        syncFile(sealedPath);
        const activeFd = openSync(activeSidecarPath, "a", 0o600);
        try { fsyncSync(activeFd); } finally { closeSync(activeFd); }
        syncDirectory(sealedPath);
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
        }) + "\\n");
        writerGeneration = randomUUID();
        return true;
      } catch (error) {
        // A failed publish may have written a proof after the sealed pathname
        // was published but before the complete operation returned. Removing
        // it makes restart use the conservative retained-anchor path.
        if (proofPath) {
          try {
            rmSync(proofPath, { force: true });
            syncDirectory(proofPath);
          } catch { /* best effort */ }
        }
        if (error && error.code === "ENOENT") continue;
        return false;
      }
    }
    return false;
  };
  let sidecarWriteStopped = false;
  const pendingSidecars = [];
  let sidecarRetryTimer = null;
  const scheduleSidecarRetry = () => {
    if (sidecarWriteStopped || sidecarRetryTimer !== null) return;
    sidecarRetryTimer = setTimeout(() => {
      sidecarRetryTimer = null;
      // The queue head may have committed while this timer was pending;
      // retry whichever exact identity is now blocking the FIFO.
      flushPendingSidecar();
    }, SIDECAR_APPEND_RETRY_MS);
  };
  const failPendingSidecar = (pending, error) => {
    pending.attempts++;
    if (pending.attempts >= SIDECAR_MAX_APPEND_RETRIES) {
      sidecarWriteStopped = true;
      quarantineAdmission("sidecar append did not become durable within the bounded retry budget");
      console.warn("[sidecar] event append stopped after bounded retries", error);
      return;
    }
    scheduleSidecarRetry();
  };
  const flushPendingSidecar = () => {
    if (pendingSidecars.length === 0 || sidecarWriteStopped) return false;
    while (pendingSidecars.length > 0) {
      const pending = pendingSidecars[0];
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (!waitForSidecarBackpressure()) throw new Error("sidecar admission is paused");
        if (pending.line === null) {
          const draft = JSON.stringify({ ...pending.event, bridgeId, seq: pending.seq, generation: writerGeneration }) + "\\n";
          if (!sealBeforeAppend(Buffer.byteLength(draft, "utf8"), seq)) throw new Error("sidecar generation is not publishable");
          // Rotation assigns the next active inode a fresh generation. Keep the
          // post-rotation bytes as the pending identity for every retry.
          pending.generation = writerGeneration;
          pending.line = JSON.stringify({ ...pending.event, bridgeId, seq: pending.seq, generation: pending.generation }) + "\\n";
        }
        appendDurable(activeSidecarPath, pending.line);
        // Commit only after the exact reserved line has been durably appended.
        seq = pending.seq;
        pendingSidecars.shift();
        pending.attempts = 0;
      } catch (error) {
        failPendingSidecar(pending, error);
        return false;
      }
    }
    return true;
  };
  const log = (event: Record<string, unknown>): void => {
    if (sidecarWriteStopped) return;
    // Reserve in call order even while an earlier append is retrying. Later
    // records stay queued behind the exact failed identity instead of being
    // silently dropped by a transient filesystem error.
    if (pendingSidecars.length >= SIDECAR_MAX_PENDING_EVENTS) {
      sidecarWriteStopped = true;
      quarantineAdmission("sidecar pending event queue exceeded its bounded admission");
      console.warn("[sidecar] event append stopped after pending queue overflow");
      return;
    }
    const pending = { event, seq: seq + pendingSidecars.length + 1, generation: null, line: null, attempts: 0 };
    pendingSidecars.push(pending);
    void flushPendingSidecar();
  };
  /** Poll for the app's acknowledgement file, consume it exactly once. */
  const waitForAck = (requestId: string, timeoutMs: number): Promise<Record<string, unknown> | null> => {
    const ackPath = join(dir, \`ack-\${id}-\${requestId}.json\`);
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const poll = (): void => {
        try {
          const claimedPath = \`\${ackPath}.claimed-\${bridgeId}\`;
          renameSync(ackPath, claimedPath);
          try {
            const raw = readFileSync(claimedPath, "utf8");
            resolve(JSON.parse(raw) as Record<string, unknown>);
          } finally {
            rmSync(claimedPath, { force: true });
          }
          return;
        } catch {
          /* not written yet */
        }
        if (Date.now() > deadline) {
          resolve(null);
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  };
  /** One-use preflight state carried from input to agent_start. */
  let preflight: { requestId: string; token: string | null } | null = null;
  let planLogged = false;
  /** Provider-qualified model id for --model. A bare id is ambiguous. */
  function modelRef(model) {
    if (!model || typeof model.id !== "string" || !model.id) return null;
    return typeof model.provider === "string" && model.provider ? model.provider + "/" + model.id : model.id;
  }
  function logSettings(ctx) {
    log({ t: "agent_settings", model: modelRef(ctx.model), thinkingLevel: ctx.thinkingLevel ?? null });
  }

  // ---- project trust (WORLDLINES §6.7) ----
  // A candidate inherits one-process trust only when the app granted it:
  // the run was trusted and its trust-sensitive resources still match.
  // The grant never persists the candidate path (remember: false).
  pi.on("project_trust", async () => {
    if (process.env.TERMINA_INHERIT_TRUST === "1") {
      return { trusted: "yes" as const, remember: false };
    }
    return { trusted: "undecided" as const };
  });

  // ---- startup control (WORLDLINES §6.7) ----
  // Dispatch workers use startup-control-<terminal-id>.json in the shared
  // events directory. Worldline candidates use startup-control.json in
  // their own events directory. The bridge consumes the file once.
  pi.on("session_start", (_event, ctx) => {
    let control: { opId?: unknown; action?: unknown; text?: unknown; content?: unknown } | null = null;
    try {
      const namedPath = join(dir, \`startup-control-\${id}.json\`);
      const genericPath = join(dir, "startup-control.json");
      let claimedPath = \`\${namedPath}.claimed-\${bridgeId}\`;
      try {
        renameSync(namedPath, claimedPath);
      } catch {
        claimedPath = \`\${genericPath}.claimed-\${bridgeId}\`;
        renameSync(genericPath, claimedPath);
      }
      try {
        const raw = readFileSync(claimedPath, "utf8");
        control = JSON.parse(raw) as { opId?: unknown; action?: unknown; text?: unknown; content?: unknown };
      } finally {
        rmSync(claimedPath, { force: true });
      }
    } catch {
      /* no control: a reload after application */
    }
    const opId = String(control?.opId ?? "");
    if (!control) {
      log({ t: "session_ready", opId, ok: true, reload: true });
      logSettings(ctx);
      return;
    }
    try {
      if (control.action === "prefill" && typeof control.text === "string") {
        // Editable text: the user can change it before submitting.
        ctx.ui.setEditorText(control.text);
      } else if (control.action === "structured") {
        // One-shot marker: a reload cannot submit the prompt twice.
        pi.appendEntry("termina-control", { opId });
        const content = Array.isArray(control.content) ? control.content : [String(control.text ?? "")];
        pi.sendUserMessage(content);
      }
      log({ t: "session_ready", opId, ok: true });
    } catch (err) {
      log({ t: "session_ready", opId, ok: false, error: String(err) });
    }
    logSettings(ctx);
  });
  pi.on("model_select", (event, ctx) => {
    log({ t: "agent_settings", model: modelRef(event.model), thinkingLevel: ctx.thinkingLevel ?? null });
  });
  pi.on("thinking_level_select", (event, ctx) => {
    log({ t: "agent_settings", model: modelRef(ctx.model), thinkingLevel: event.level ?? null });
  });

  // ---- run-start preflight (WORLDLINES §6.3) ----
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive") return { action: "continue" };
    const text = String(event.text ?? "").trim();
    const images = (event.images ?? []) as unknown[];
    if (!ctx.isIdle()) {
      // A steering interrupt or queued follow-up: the open run cannot be
      // replayed as one task.
      log({ t: "steer_input", behavior: String(event.streamingBehavior ?? "steer") });
      return { action: "continue" };
    }
    if (!text && images.length === 0) return { action: "continue" };
    const requestId = randomUUID();
    const timeoutMs = 15000;
    log({ t: "preflight_request", requestId, hasImages: images.length > 0, deadlineAt: Date.now() + timeoutMs });
    const ack = await waitForAck(requestId, timeoutMs);
    if (!ack || ack.ok !== true) {
      // A timeout has no token, so cancel by the durable request identity.
      log({ t: "preflight_cancel", requestId });
      const err = String((ack as { error?: unknown })?.error ?? "preflight timed out");
      // Keep the draft editable: restore the raw text and do not start.
      if (text) ctx.ui.setEditorText(String(event.text ?? ""));
      ctx.ui.notify("termina: the run did not start (" + err + "). Your text is still in the editor.", "warning");
      return { action: "handled" };
    }
    preflight = { requestId, token: (ack as { token?: string | null }).token ?? null };
    return { action: "continue" };
  });

  pi.on("agent_start", (event, ctx) => {
    planLogged = false;
    const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
    const leafId = ctx.sessionManager.getLeafId();
    const parentId = leafId ? (ctx.sessionManager.getEntry(leafId)?.parentId ?? null) : null;
    log({
      t: "agent_start",
      preflightRequestId: preflight?.requestId ?? null,
      preflightToken: preflight?.token ?? null,
      sessionFile,
      sessionId: ctx.sessionManager.getSessionId(),
      entryId: leafId,
      parentEntryId: parentId,
      trusted: ctx.isProjectTrusted(),
      model: modelRef(ctx.model),
      thinkingLevel: ctx.thinkingLevel ?? null,
    });
    preflight = null;
  });

  // The settled boundary: report the settle, then ask for a checkpoint
  // and wait for the outcome.
  pi.on("agent_settled", async (event, ctx) => {
    planLogged = true;
    log({ t: "agent_settled" });
    const requestId = randomUUID();
    log({ t: "checkpoint_request", requestId, kind: "settled", entryId: ctx.sessionManager.getLeafId() });
    const ack = await waitForAck(requestId, 5000);
    log({ t: "checkpoint_result", requestId, ok: ack?.ok === true, error: (ack as { error?: unknown })?.error ?? null });
  });

  function visibleAssistantText(message) {
    const content = message && message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "thinking" || part.type === "reasoning") return "";
      return typeof part.text === "string" ? part.text : "";
    }).join("\\n");
  }
  const PLAN_TASK = new RegExp(${JSON.stringify(HAS_PLAN_TASK.source)}, ${JSON.stringify(HAS_PLAN_TASK.flags)});
  function hasPlanTask(text) {
    return PLAN_TASK.test(text);
  }
  // Plan Board: first assistant message with an explicit Plan heading and task list.
  pi.on("message_end", (event) => {
    if (planLogged) return;
    const message = event.message;
    if (!message || message.role !== "assistant") return;
    const text = visibleAssistantText(message);
    if (!text.trim() || !hasPlanTask(text)) return;
    planLogged = true;
    log({ t: "plan", text: text.slice(0, 4000) });
  });
  // Feed the latest context files (test results, user edits) into the
  // agent's next turn. Capture the effective expanded prompt and images in
  // an app-private payload file first.
  pi.on("before_agent_start", async (event) => {
    let context = "";
    for (const name of [\`verify-\${id}.md\`, \`edits-\${id}.md\`, \`mine-\${id}.md\`, \`mailbox-\${id}.md\`]) {
      try {
        const text = readFileSync(join(dir, name), "utf8");
        if (text) context += (context ? "\\n\\n---\\n\\n" : "") + text;
      } catch {}
    }
    try {
      const file = \`prompt-\${id}-\${bridgeId.slice(0, 8)}-\${seq}.json\`;
      writeFileSync(join(dir, file), JSON.stringify({ prompt: event.prompt, images: event.images ?? [], context }), { mode: 0o600 });
      log({ t: "prompt", file, hasPreflight: preflight !== null });
    } catch {}
    if (!context) return;
    return {
      message: { customType: "termina-context", content: context, display: false },
    };
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    if (!FILE_TOOLS.has(event.toolName)) return;
    const args = (event.args ?? {}) as { path?: unknown; edits?: unknown };
    if (typeof args.path === "string" && args.path) {
      const bounded = event.toolName === "edit" || event.toolName === "apply_patch" ? boundedSidecarEdits(args.edits) : undefined;
      log({
        t: "tool",
        toolName: event.toolName,
        path: args.path,
        ...(bounded ?? {}),
        // The tool call id correlates the result; the leaf id is the
        // session entry of this moment (parallel siblings share it).
        toolCallId: event.toolCallId,
        entryId: ctx?.sessionManager?.getLeafId?.() ?? null,
      });
    }
  });
  pi.on("tool_execution_end", async (event) => {
    // The tool finished: its disk effects landed (the watcher confirms
    // them); this is the moment-capture scheduling signal.
    log({ t: "tool_end", toolCallId: event.toolCallId, isError: !!event.isError });
  });
}
`;
