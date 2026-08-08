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
  /** seq → dot element, for O(1) updates (defensive; main rarely re-sends). */
  private dots = new Map<number, HTMLElement>();
  private activeSeq: number | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private replayIdx = 0;

  private onJump: (ev: TimelineEvent) => void = () => {};

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

  bind(handlers: { onJump: (ev: TimelineEvent) => void }): void {
    this.onJump = handlers.onJump;
  }

  setEvents(events: TimelineEvent[]): void {
    this.stopReplay();
    this.events = events;
    this.activeSeq = null;
    this.render();
  }

  /** Append a new point (or refresh an existing one by seq — updates from
   *  main re-use the same seq). O(1) — no full re-render per event. */
  push(event: TimelineEvent): void {
    const idx = this.events.findIndex((e) => e.seq === event.seq);
    if (idx !== -1) this.events[idx] = event;
    else this.events.push(event);
    const existing = this.dots.get(event.seq);
    if (existing) {
      existing.className = this.dotClass(event);
      existing.title = this.tooltip(event);
      return;
    }
    const dot = this.makeDot(event);
    this.dots.set(event.seq, dot);
    this.dotsEl.appendChild(dot);
    this.countEl.textContent = `(${this.events.length})`;
    this.btnPlay.hidden = this.events.length === 0;
    // Keep the newest dot in view — but only when the user is already near
    // the end, so examining an old moment isn't yanked away by new events.
    const nearEnd = this.dotsEl.scrollLeft + this.dotsEl.clientWidth >= this.dotsEl.scrollWidth - 24;
    if (nearEnd) this.dotsEl.scrollLeft = this.dotsEl.scrollWidth;
  }

  /** Highlight a dot (used while replaying). */
  private highlight(seq: number): void {
    this.activeSeq = seq;
    for (const [s, el] of this.dots) el.classList.toggle("active", s === seq);
  }

  private dotClass(ev: TimelineEvent): string {
    return `timeline-dot t-${ev.t}${ev.toolName ? ` tool-${ev.toolName}` : ""}`;
  }

  private makeDot(ev: TimelineEvent): HTMLElement {
    const dot = document.createElement("span");
    dot.className = this.dotClass(ev);
    dot.dataset.seq = String(ev.seq);
    dot.title = this.tooltip(ev);
    dot.addEventListener("click", () => this.jumpTo(ev));
    if (ev.seq === this.activeSeq) dot.classList.add("active");
    return dot;
  }

  private render(): void {
    const n = this.events.length;
    this.countEl.textContent = n ? `(${n})` : "";
    this.btnPlay.hidden = n === 0;
    this.dotsEl.replaceChildren();
    this.dots.clear();
    for (const ev of this.events) {
      const dot = this.makeDot(ev);
      this.dots.set(ev.seq, dot);
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

  /** Jump to a moment: open its snapshot via the bound handler. Content is
   *  fetched on demand by the handler, so every tool/change point jumps. */
  jumpTo(ev: TimelineEvent): void {
    this.stopReplay();
    this.highlight(ev.seq);
    if (ev.t === "tool" || ev.t === "change") this.onJump(ev);
    // Run markers (start/settled) are silent moments.
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
