/**
 * Tails the per-terminal sidecar files written by the pi-editor bridge
 * extension (tool calls, busy state) and emits structured events.
 * Reads only the new bytes since the last poll — a session file grows
 * without bound, and reading it whole every 150 ms would cost O(n^2).
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SidecarEvent {
  t: "agent_start" | "agent_settled" | "tool" | "plan";
  toolName?: string;
  path?: string;
  /** The edit regions of edit/apply_patch tool calls (for baselines). */
  edits?: Array<{ oldText?: string; newText?: string }>;
  /** The plan text (the first assistant message of a run). */
  text?: string;
}

export class SidecarTailer {
  private offsets = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  onEvent: (terminalId: string, event: SidecarEvent) => void = () => {};

  constructor(private dir: string) {}

  start(): void {
    this.timer = setInterval(() => {
      for (const id of this.offsets.keys()) this.tail(id);
    }, 150);
  }

  /** Start tailing a terminal's event file. Events written before this call
   *  belong to previous app sessions (the file is global) — start from the
   *  current size so a fresh instance never replays phantom history. */
  watch(id: string): void {
    let start = 0;
    try {
      start = statSync(join(this.dir, `${id}.jsonl`)).size;
    } catch {
      /* file does not exist yet — start from zero */
    }
    this.offsets.set(id, start);
  }

  stopWatching(id: string): void {
    this.offsets.delete(id);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tail(id: string): void {
    const file = join(this.dir, `${id}.jsonl`);
    let offset = this.offsets.get(id) ?? 0;
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return; // not written yet
    }
    if (size < offset) offset = 0; // file was truncated/rotated
    if (size === offset) return;
    // Read from the offset, not from the start. Cap each read so a huge
    // backlog cannot allocate an oversized buffer.
    const want = size - offset;
    const cap = Math.min(want, 1024 * 1024);
    let fd: number | null = null;
    let text = "";
    let got = 0;
    try {
      fd = openSync(file, "r");
      const buffer = Buffer.alloc(cap);
      got = readSync(fd, buffer, 0, cap, offset);
      text = buffer.subarray(0, got).toString("utf8");
    } catch {
      return; // transient read error — retried next poll
    } finally {
      if (fd !== null) closeSync(fd);
    }
    // Advance only past the last complete line. A partial trailing line (no
    // newline yet) stays behind and is retried next poll — advancing would
    // lose the event forever.
    const lastNl = text.lastIndexOf("\n");
    if (lastNl === -1) return;
    this.offsets.set(id, offset + lastNl + 1);
    const lines = text.slice(0, lastNl + 1).split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as SidecarEvent;
        if (event && typeof event.t === "string") this.onEvent(id, event);
      } catch {
        /* malformed line — skip */
      }
    }
  }
}