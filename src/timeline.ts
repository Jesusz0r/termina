/**
 * Session Timeline ("time machine"): a compact strip under the terminal
 * showing every agent action with a dot. Clicking a dot opens the file as it
 * looked at that exact moment (read-only snapshot tab); ▶ replays the run.
 * A forkable dot (captured source state) forks a candidate at that moment
 * with Cmd/Ctrl+Click.
 */
import type { TimelineEvent, RecorderState } from "../shared/types";

export class TimelineView {
  private dotsEl: HTMLElement;
  private countEl: HTMLElement;
  private btnPlay: HTMLElement;
  private recorderEl: HTMLElement;
  private events: TimelineEvent[] = [];
  /** seq → dot element, for O(1) updates (defensive; main rarely re-sends). */
  private dots = new Map<number, HTMLElement>();
  private activeSeq: number | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private replayIdx = 0;

  private onJump: (ev: TimelineEvent, opts?: { replay?: boolean }) => void = () => {};
  private onFork: (ev: TimelineEvent) => void = () => {};

  constructor(container: HTMLElement) {
    this.dotsEl = container.querySelector("#timeline-dots")!;
    this.countEl = container.querySelector("#timeline-count")!;
    this.recorderEl = container.querySelector("#timeline-recorder")!;
    this.btnPlay = container.querySelector("#btn-timeline-play")!;
    this.btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleReplay();
    });
  }

  bind(handlers: { onJump: (ev: TimelineEvent, opts?: { replay?: boolean }) => void; onFork: (ev: TimelineEvent) => void }): void {
    this.onJump = handlers.onJump;
    this.onFork = handlers.onFork;
  }

  /** The recorder state label (indexing / ready / paused / degraded / budget). */
  setRecorder(state: RecorderState): void {
    this.recorderEl.textContent = state === "ready" ? "" : state;
    this.recorderEl.className = `timeline-recorder rec-${state}`;
    this.recorderEl.hidden = state === "ready";
    this.recorderEl.title =
      state === "indexing"
        ? "indexing the source for moment forking"
        : state === "paused"
          ? "moment forking is paused (no Git recording)"
          : state === "degraded"
            ? "some moments could not be captured"
            : "the fork-point budget is evicting old moments";
  }

  /** Drop evicted dots (their source states are gone). */
  evict(seqs: number[]): void {
    const gone = new Set(seqs);
    this.events = this.events.filter((e) => !gone.has(e.seq));
    for (const seq of seqs) {
      this.dots.get(seq)?.remove();
      this.dots.delete(seq);
    }
    this.countEl.textContent = this.events.length ? `(${this.events.length})` : "";
    this.btnPlay.hidden = this.events.length === 0;
  }

  setEvents(events: TimelineEvent[]): void {
    this.stopReplay();
    // Copy: the renderer's pane.timeline aliased this array, so its pushes
    // mutated the view's events and push() never created the dots.
    this.events = [...events];
    this.activeSeq = null;
    this.render();
  }

  /** Append a new point (or refresh an existing one by seq — updates from
   *  main re-use the same seq). O(1) — no full re-render per event. */
  push(event: TimelineEvent): void {
    const idx = this.events.findIndex((e) => e.seq === event.seq);
    if (idx !== -1) {
      this.events[idx] = event;
      const existing = this.dots.get(event.seq);
      if (existing) {
        existing.className = this.dotClass(event);
        existing.title = this.tooltip(event);
      }
      return;
    }
    this.events.push(event);
    const dot = this.makeDot(event);
    this.dots.set(event.seq, dot);
    this.dotsEl.appendChild(dot);
    this.countEl.textContent = `(${this.events.length})`;
    this.btnPlay.hidden = this.events.length === 0;
    // Keep the newest dot in view — but only when the user is already near
    // the end, so new events do not pull the view away from an old moment.
    const nearEnd = this.dotsEl.scrollLeft + this.dotsEl.clientWidth >= this.dotsEl.scrollWidth - 24;
    if (nearEnd) this.dotsEl.scrollLeft = this.dotsEl.scrollWidth;
  }

  /** Highlight a dot (used while replaying). */
  private highlight(seq: number): void {
    this.activeSeq = seq;
    let activeEl: HTMLElement | null = null;
    for (const [s, el] of this.dots) {
      const on = s === seq;
      el.classList.toggle("active", on);
      if (on) activeEl = el;
    }
    // Center the active dot: replay steps beyond the visible strip width.
    if (activeEl) {
      const left = activeEl.offsetLeft - this.dotsEl.clientWidth / 2;
      this.dotsEl.scrollLeft = Math.max(0, left);
    }
  }

  private dotClass(ev: TimelineEvent): string {
    return `timeline-dot t-${ev.t}${ev.toolName ? ` tool-${ev.toolName}` : ""}${ev.stateId ? " forkable" : ev.evicted ? " evicted" : ""}`;
  }

  private makeDot(ev: TimelineEvent): HTMLElement {
    const dot = document.createElement("span");
    dot.className = this.dotClass(ev);
    dot.dataset.seq = String(ev.seq);
    dot.title = this.tooltip(ev);
    dot.addEventListener("click", (e) => {
      if ((e.metaKey || e.ctrlKey) && ev.stateId) {
        e.stopPropagation();
        this.forkAt(ev);
        return;
      }
      this.jumpTo(ev);
    });
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
    // the end, so new events do not pull the view away from an old moment.
    const nearEnd = this.dotsEl.scrollLeft + this.dotsEl.clientWidth >= this.dotsEl.scrollWidth - 24;
    if (n > 0 && nearEnd) this.dotsEl.scrollLeft = this.dotsEl.scrollWidth;
  }

  private tooltip(ev: TimelineEvent): string {
    const time = new Date(ev.ts).toLocaleTimeString();
    const fork = ev.stateId ? " — Cmd/Ctrl+Click to fork at this moment" : ev.evicted ? " (source evicted)" : "";
    switch (ev.t) {
      case "agent_start":
        return `${time} — run started`;
      case "agent_settled":
        return `${time} — run settled`;
      case "tool":
        return `${time} — ${ev.toolName} ${ev.relPath ?? ""}${ev.content === undefined ? " (no snapshot)" : ""}${fork}`;
      case "change":
        return `${time} — changed on disk: ${ev.relPath ?? ""}${fork}`;
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

  /** Cmd/Ctrl+Click on a forkable dot: fork a candidate at this moment. */
  forkAt(ev: TimelineEvent): void {
    this.stopReplay();
    this.highlight(ev.seq);
    this.onFork(ev);
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
      // Fetch content on demand: the strip events carry none (lazy content).
      if (ev.t === "tool" || ev.t === "change") this.onJump(ev, { replay: true });
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
