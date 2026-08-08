/**
 * Tails the per-terminal sidecar files written by the pi-editor bridge
 * extension (tool calls, busy state) and emits structured events.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SidecarToolEvent {
  t: "tool";
  toolName: string;
  path: string;
}

export interface SidecarBusyEvent {
  t: "agent_start" | "agent_settled";
}

export type SidecarEvent = SidecarToolEvent | SidecarBusyEvent;

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

  /** Start tailing a terminal's event file. */
  watch(id: string): void {
    this.offsets.set(id, 0);
    this.tail(id);
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
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      return;
    }
    this.offsets.set(id, size);
    const lines = content.slice(offset).split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as SidecarEvent;
        if (event && typeof event.t === "string") this.onEvent(id, event);
      } catch {
        /* partial line at EOF — retried next poll */
      }
    }
  }
}