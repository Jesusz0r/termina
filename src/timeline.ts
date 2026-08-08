/**
 * Session Timeline ("time machine"): a compact strip under the terminal
 * showing every agent action with a dot. Clicking a dot opens the file as it
 * looked at that exact moment (read-only snapshot tab); ▶ replays the run.
 */
import type { TimelineEvent } from "../shared/types";

export class TimelineView {
  private root: HTMLElement;
  private dotsEl: HTMLElement;
  private countEl: HTMLElement;
  private btnPlay: HTMLElement;
  private events: TimelineEvent[] = [];
  private activeSeq: number | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private replayIdx = 0;

  private onJump: (ev: TimelineEvent) => void = () => {};
  private onNoSnapshot: (ev: TimelineEvent) => void = () => {};

  constructor(container: HTMLElement) {
    this.root = container;
    this.dotsEl = container.querySelector("#timeline-dots")!;
    this.countEl = container.querySelector("#timeline-count")!;
    this.btnPlay = container.querySelector("#btn-timeline-play")!;
    this.btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleReplay();
    });
  }

  bind(handlers: { onJump: (ev: TimelineEvent) => void; onNoSnapshot?: (ev: TimelineEvent) => void }): void {
    this.onJump = handlers.onJump;
    if (handlers.onNoSnapshot) this.onNoSnapshot = handlers.onNoSnapshot;
  }

  setEvents(events: TimelineEvent[]): void {
    this.stopReplay();
    this.events = events;
    this.activeSeq = null;
    this.render();
  }

  push(event: TimelineEvent): void {
    this.events.push(event);
    this.render();
  }

  /** Highlight a dot (used while replaying). */
  private highlight(seq: number): void {
    this.activeSeq = seq;
    for (const dot of this.dotsEl.children) {
      const el = dot as HTMLElement;
      el.classList.toggle("active", el.dataset.seq === String(seq));
    }
  }

  private render(): void {
    const n = this.events.length;
    this.countEl.textContent = n ? `(${n})` : "";
    this.btnPlay.hidden = n === 0;
    this.dotsEl.replaceChildren();
    for (const ev of this.events) {
      const dot = document.createElement("span");
      dot.className = `timeline-dot t-${ev.t}${ev.toolName ? ` tool-${ev.toolName}` : ""}`;
      dot.dataset.seq = String(ev.seq);
      dot.title = this.tooltip(ev);
      dot.addEventListener("click", () => this.jumpTo(ev));
      if (ev.seq === this.activeSeq) dot.classList.add("active");
      this.dotsEl.appendChild(dot);
    }
    // Keep the newest dot in view — but only when the user is already near
    // the end, so examining an old moment isn't yanked away by new events.
    const nearEnd = this.dotsEl.scrollLeft + this.dotsEl.clientWidth >= this.dotsEl.scrollWidth - 24;
    if (n > 0 && nearEnd) this.dotsEl.scrollLeft = this.dotsEl.scrollWidth;
  }

  private tooltip(ev: TimelineEvent): string {
    const time = new Date(ev.ts).toLocaleTimeString();
    switch (ev.t) {
      case "agent_start":
        return `${time} — run started`;
      case "agent_settled":
        return `${time} — run settled`;
      case "tool":
        return `${time} — ${ev.toolName} ${ev.relPath ?? ""}${ev.content === undefined ? " (no snapshot)" : ""}`;
      case "change":
        return `${time} — changed on disk: ${ev.relPath ?? ""}`;
    }
  }

  /** Jump to a moment: open its snapshot via the bound handler. */
  jumpTo(ev: TimelineEvent): void {
    this.stopReplay();
    this.highlight(ev.seq);
    if (ev.content !== undefined && ev.path) {
      this.onJump(ev);
      return;
    }
    // Run markers (start/settled) are silent; content-less tool/change points
    // (snapshot too large) explain themselves.
    if (ev.t === "tool" || ev.t === "change") this.onNoSnapshot(ev);
  }

  toggleReplay(): void {
    if (this.replayTimer) {
      this.stopReplay();
      return;
    }
    const n = this.events.length;
    if (n === 0) return;
    this.replayIdx = 0;
    const step = (): void => {
      if (this.replayIdx >= this.events.length) {
        this.stopReplay();
        return;
      }
      const ev = this.events[this.replayIdx++];
      this.highlight(ev.seq);
      if (ev.content !== undefined && ev.path) this.onJump(ev);
    };
    step();
    this.replayTimer = setInterval(step, 650);
    this.btnPlay.classList.add("playing");
    this.btnPlay.textContent = "■";
  }

  private stopReplay(): void {
    if (this.replayTimer) clearInterval(this.replayTimer);
    this.replayTimer = null;
    this.btnPlay.classList.remove("playing");
    this.btnPlay.textContent = "▶";
  }
}
