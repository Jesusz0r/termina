/**
 * Tails the per-terminal sidecar files written by the Pi/ditor bridge
 * extension (tool calls, busy state, run-boundary events) and emits
 * structured events.
 * Delivery is event-driven: an fs.watch on the events directory triggers
 * immediate tails. The interval poll remains as recovery for missed watch
 * events. Reads only the new bytes since the last poll. The sidecar rotates
 * at a bounded size.
 */
import { watch, type FSWatcher } from "node:fs";
import { statSync, truncateSync } from "node:fs";
import { open as openFile, stat as statFile, truncate as truncateFile } from "node:fs/promises";
import { join } from "node:path";

export interface SidecarEvent {
  t: "agent_start" | "agent_settled" | "tool" | "tool_end" | "plan" | "preflight_request" | "prompt" | "steer_input" | "checkpoint_request" | "checkpoint_result" | "session_ready";
  toolName?: string;
  path?: string;
  /** The edit regions of edit/apply_patch tool calls (for baselines). */
  edits?: Array<{ oldText?: string; newText?: string }>;
  /** The tool call id (correlates the tool result). */
  toolCallId?: string;
  isError?: boolean;
  /** The plan text (the first assistant message of a run). */
  text?: string;
  /** Bridge instance id (monotonic sequence resets with it). */
  bridgeId?: string;
  /** Monotonic event sequence within one bridge instance. */
  seq?: number;
  requestId?: string;
  kind?: string;
  entryId?: string | null;
  parentEntryId?: string | null;
  sessionFile?: string | null;
  sessionId?: string | null;
  trusted?: boolean;
  preflightToken?: string | null;
  preflightRequestId?: string | null;
  /** The prompt payload file in the events directory. */
  file?: string;
  hasImages?: boolean;
  behavior?: string;
  ok?: boolean;
  error?: string | null;
  /** The selected model and thinking level (agent_start). */
  model?: string | null;
  thinkingLevel?: string | null;
  /** The startup control id (session_ready). */
  opId?: string;
}

const MAX_SIDECAR_BYTES = 8 * 1024 * 1024;

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
      try {
        const event = JSON.parse(line) as SidecarEvent;
        if (event && this.acceptEvent(id, event)) this.onEvent(id, event);
      } catch {
        /* malformed line — skip */
      }
    }
    const currentSize = this.offsets.get(id) ?? 0;
    if (this.offsets.has(id) && currentSize >= MAX_SIDECAR_BYTES) {
      try {
        await truncateFile(file, 0);
        this.offsets.set(id, 0);
        this.streams.delete(id);
        this.bridgeIds.delete(id);
      } catch {
        /* The bridge can continue appending. */
      }
    }
  }

  private acceptEvent(id: string, event: SidecarEvent): boolean {
    const sequence = event.seq;
    if (typeof event.bridgeId !== "string" || typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) return false;
    const previous = this.streams.get(id);
    const known = this.bridgeIds.get(id) ?? new Set<string>();
    if (known.has(event.bridgeId) && previous?.bridgeId !== event.bridgeId) return false;
    if (previous?.bridgeId === event.bridgeId && sequence <= previous.sequence) return false;
    known.add(event.bridgeId);
    while (known.size > 8) known.delete(known.values().next().value!);
    this.bridgeIds.set(id, known);
    this.streams.set(id, { bridgeId: event.bridgeId, sequence });
    return true;
  }
}
