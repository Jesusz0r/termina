/**
 * Sidecar protocol: JSONL events the bridge writes and the app tails.
 *
 * The bridge extension is the only writer. This module is the only parser
 * and the only tailer of sidecar JSONL.
 */
import { watch, type FSWatcher } from "node:fs";
import { statSync, truncateSync } from "node:fs";
import { open as openFile, stat as statFile, truncate as truncateFile } from "node:fs/promises";
import { join } from "node:path";

export const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;

type ToolEdits = Array<{ oldText?: string; newText?: string }>;

interface SidecarMeta {
  bridgeId: string;
  seq: number;
}

export type SidecarEvent =
  | (SidecarMeta & { t: "preflight_request"; requestId?: string; hasImages?: boolean })
  | (SidecarMeta & { t: "prompt"; file?: string; hasPreflight?: boolean })
  | (SidecarMeta & { t: "steer_input"; behavior?: string })
  | (SidecarMeta & { t: "checkpoint_request"; requestId?: string; kind?: string; entryId?: string | null })
  | (SidecarMeta & { t: "checkpoint_result"; requestId?: string; ok?: boolean; error?: string | null })
  | (SidecarMeta & { t: "session_ready"; opId?: string; ok?: boolean; error?: string | null })
  | (SidecarMeta & {
      t: "agent_start";
      preflightRequestId?: string | null;
      preflightToken?: string | null;
      sessionFile?: string | null;
      sessionId?: string | null;
      entryId?: string | null;
      parentEntryId?: string | null;
      trusted?: boolean;
      model?: string | null;
      thinkingLevel?: string | null;
    })
  | (SidecarMeta & { t: "agent_settled" })
  | (SidecarMeta & { t: "agent_settings"; model?: string | null; thinkingLevel?: string | null })
  | (SidecarMeta & { t: "plan"; text?: string })
  | (SidecarMeta & {
      t: "tool";
      toolName?: string;
      path?: string;
      edits?: ToolEdits;
      toolCallId?: string;
      entryId?: string | null;
    })
  | (SidecarMeta & { t: "tool_end"; toolCallId?: string; isError?: boolean });

export type AgentStartEvent = Extract<SidecarEvent, { t: "agent_start" }>;

const SIDECAR_KINDS = new Set<SidecarEvent["t"]>([
  "preflight_request",
  "prompt",
  "steer_input",
  "checkpoint_request",
  "checkpoint_result",
  "session_ready",
  "agent_start",
  "agent_settled",
  "agent_settings",
  "plan",
  "tool",
  "tool_end",
]);

/** One JSONL object. Arrays, primitives, and malformed JSON are not records. */
export function parseSidecarRecord(line: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** bridgeId plus a monotonic seq. Unknown kinds still occupy this slot. */
function sidecarEnvelope(rec: Record<string, unknown>): SidecarMeta | null {
  const bridgeId = rec.bridgeId;
  const seq = rec.seq;
  if (typeof bridgeId !== "string" || bridgeId.length === 0) return null;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return null;
  return { bridgeId, seq };
}

export function sidecarEventFromRecord(rec: Record<string, unknown>): SidecarEvent | null {
  const envelope = sidecarEnvelope(rec);
  if (!envelope) return null;
  return sidecarEventBody(envelope, rec);
}

function isSidecarKind(t: string): t is SidecarEvent["t"] {
  return SIDECAR_KINDS.has(t as SidecarEvent["t"]);
}

function sidecarEventBody(meta: SidecarMeta, rec: Record<string, unknown>): SidecarEvent | null {
  const t = rec.t;
  if (typeof t !== "string" || !isSidecarKind(t)) return null;
  switch (t) {
    case "preflight_request":
      return { ...meta, t: "preflight_request", requestId: optionalString(rec.requestId), hasImages: optionalBoolean(rec.hasImages) };
    case "prompt":
      return { ...meta, t: "prompt", file: optionalString(rec.file), hasPreflight: optionalBoolean(rec.hasPreflight) };
    case "steer_input":
      return { ...meta, t: "steer_input", behavior: optionalString(rec.behavior) };
    case "checkpoint_request":
      return {
        ...meta,
        t: "checkpoint_request",
        requestId: optionalString(rec.requestId),
        kind: optionalString(rec.kind),
        entryId: optionalStringOrNull(rec.entryId),
      };
    case "checkpoint_result":
      return {
        ...meta,
        t: "checkpoint_result",
        requestId: optionalString(rec.requestId),
        ok: optionalBoolean(rec.ok),
        error: optionalStringOrNull(rec.error),
      };
    case "session_ready":
      return {
        ...meta,
        t: "session_ready",
        opId: optionalString(rec.opId),
        ok: optionalBoolean(rec.ok),
        error: optionalStringOrNull(rec.error),
      };
    case "agent_start":
      return {
        ...meta,
        t: "agent_start",
        preflightRequestId: optionalStringOrNull(rec.preflightRequestId),
        preflightToken: optionalStringOrNull(rec.preflightToken),
        sessionFile: optionalStringOrNull(rec.sessionFile),
        sessionId: optionalStringOrNull(rec.sessionId),
        entryId: optionalStringOrNull(rec.entryId),
        parentEntryId: optionalStringOrNull(rec.parentEntryId),
        trusted: optionalBoolean(rec.trusted),
        model: optionalStringOrNull(rec.model),
        thinkingLevel: optionalStringOrNull(rec.thinkingLevel),
      };
    case "agent_settled":
      return { ...meta, t: "agent_settled" };
    case "agent_settings":
      return {
        ...meta,
        t: "agent_settings",
        model: optionalStringOrNull(rec.model),
        thinkingLevel: optionalStringOrNull(rec.thinkingLevel),
      };
    case "plan":
      return { ...meta, t: "plan", text: optionalString(rec.text) };
    case "tool":
      return {
        ...meta,
        t: "tool",
        toolName: optionalString(rec.toolName),
        path: optionalString(rec.path),
        edits: optionalEdits(rec.edits),
        toolCallId: optionalString(rec.toolCallId),
        entryId: optionalStringOrNull(rec.entryId),
      };
    case "tool_end":
      return { ...meta, t: "tool_end", toolCallId: optionalString(rec.toolCallId), isError: optionalBoolean(rec.isError) };
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function optionalEdits(value: unknown): ToolEdits | undefined {
  if (!Array.isArray(value)) return undefined;
  const edits: ToolEdits = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const oldText = optionalString(rec.oldText);
    const newText = optionalString(rec.newText);
    if (oldText === undefined && newText === undefined) continue;
    edits.push({ ...(oldText !== undefined ? { oldText } : {}), ...(newText !== undefined ? { newText } : {}) });
  }
  return edits;
}

interface StreamState {
  bridgeId: string;
  sequence: number;
}

export class SidecarTailer {
  private offsets = new Map<string, number>();
  private streams = new Map<string, StreamState>();
  private bridgeIds = new Map<string, Set<string>>();
  private inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private pendingTails = new Map<string, ReturnType<typeof setTimeout>>();

  onEvent: (terminalId: string, event: SidecarEvent) => void = () => {};

  constructor(private dir: string) {}

  start(): void {
    if (this.timer) return;
    this.armWatch();
    this.timer = setInterval(() => {
      // Recovery poll: catch events the watcher missed. Also re-arm the
      // watcher when the directory did not exist yet.
      if (!this.watcher) this.armWatch();
      for (const id of this.offsets.keys()) void this.tail(id);
    }, 300);
  }

  /** Watch the events directory; a new line triggers an immediate tail. */
  private armWatch(): void {
    try {
      this.watcher?.close();
      this.watcher = watch(this.dir, (_ev, name) => {
        if (!name) return;
        const match = String(name).match(/^([^.]+)\.jsonl$/);
        if (match && this.offsets.has(match[1]!)) this.schedule(match[1]!);
      });
    } catch {
      this.watcher = null; // directory missing — retry on the next poll
    }
  }

  /** Debounce tails so a burst of appends tails once. */
  private schedule(id: string): void {
    if (!this.timer) return;
    const existing = this.pendingTails.get(id);
    if (existing) clearTimeout(existing);
    this.pendingTails.set(
      id,
      setTimeout(() => {
        this.pendingTails.delete(id);
        void this.tail(id);
      }, 10),
    );
  }

  /** Start tailing a terminal's event file. Events written before this call
   *  belong to previous app sessions (the file is global) — start from the
   *  current size so a fresh instance does not replay old history. */
  watch(id: string): void {
    const file = join(this.dir, `${id}.jsonl`);
    let start = 0;
    try {
      start = statSync(file).size;
      if (start > MAX_SIDECAR_BYTES) {
        truncateSync(file, 0);
        start = 0;
      }
    } catch {
      /* The file does not exist yet. */
    }
    this.offsets.set(id, start);
    this.streams.delete(id);
    this.bridgeIds.delete(id);
  }

  stopWatching(id: string): void {
    this.offsets.delete(id);
    this.streams.delete(id);
    this.bridgeIds.delete(id);
    const t = this.pendingTails.get(id);
    if (t) clearTimeout(t);
    this.pendingTails.delete(id);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.pendingTails.values()) clearTimeout(t);
    this.pendingTails.clear();
    this.offsets.clear();
    this.streams.clear();
    this.bridgeIds.clear();
  }

  private async tail(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    try {
      await this.readTail(id);
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async readTail(id: string): Promise<void> {
    const file = join(this.dir, `${id}.jsonl`);
    let offset = this.offsets.get(id) ?? 0;
    let size: number;
    try {
      size = (await statFile(file)).size;
    } catch {
      return; // not written yet
    }
    if (size < offset) {
      offset = 0;
      this.streams.delete(id);
      this.bridgeIds.delete(id);
    }
    if (size === offset) return;
    // Read from the offset, not from the start. Cap each read so a huge
    // backlog cannot allocate an oversized buffer.
    const want = size - offset;
    const cap = Math.min(want, 1024 * 1024);
    let text = "";
    try {
      const handle = await openFile(file, "r");
      try {
        const buffer = Buffer.alloc(cap);
        const result = await handle.read(buffer, 0, cap, offset);
        text = buffer.subarray(0, result.bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      return; // transient read error — retried next poll
    }
    if (!this.offsets.has(id)) return;
    // Advance only past the last complete line. A partial trailing line (no
    // newline yet) stays behind and is retried next poll — advancing would
    // lose the event forever.
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) return;
    this.offsets.set(id, offset + lastNl + 1);
    const lines = text.slice(0, lastNl + 1).split("\n");
    for (const line of lines) {
      if (!this.offsets.has(id)) return;
      if (!line.trim()) continue;
      const rec = parseSidecarRecord(line);
      if (!rec) continue;
      const envelope = sidecarEnvelope(rec);
      if (!envelope || !this.acceptEvent(id, envelope)) continue;
      const event = sidecarEventBody(envelope, rec);
      if (event) this.onEvent(id, event);
    }
    const currentSize = this.offsets.get(id) ?? 0;
    if (this.offsets.has(id) && currentSize >= MAX_SIDECAR_BYTES) {
      try {
        // The bridge appends with a new open per line, so truncation is
        // safe between appends. Skip the rotation when the file grew after
        // the read: the next poll catches the new bytes.
        const after = (await statFile(file)).size;
        if (after === currentSize) {
          await truncateFile(file, 0);
          this.offsets.set(id, 0);
          this.streams.delete(id);
          this.bridgeIds.delete(id);
        }
      } catch {
        /* The bridge can continue appending. */
      }
    }
  }

  private acceptEvent(id: string, envelope: SidecarMeta): boolean {
    const previous = this.streams.get(id);
    const known = this.bridgeIds.get(id) ?? new Set<string>();
    if (known.has(envelope.bridgeId) && previous?.bridgeId !== envelope.bridgeId) return false;
    if (previous?.bridgeId === envelope.bridgeId && envelope.seq <= previous.sequence) return false;
    known.add(envelope.bridgeId);
    while (known.size > 8) known.delete(known.values().next().value!);
    this.bridgeIds.set(id, known);
    this.streams.set(id, { bridgeId: envelope.bridgeId, sequence: envelope.seq });
    return true;
  }
}
