/**
 * Session Timeline: a compact strip under the terminal
 * showing every agent action with a dot. Clicking a dot opens the file as it
 * looked at that exact moment (read-only snapshot tab); ▶ replays the run.
 * A forkable dot (captured source state) forks a candidate at that moment
 * with Cmd/Ctrl+Click.
 */
import type { TimelineEvent, RecorderState, TimelinePrefix, TimelineProgress } from "../shared/types";

const MAX_TIMELINE_EVENTS = 400;

export class TimelineView {
  private dotsEl: HTMLElement;
  private countEl: HTMLElement;
  private prefixEl: HTMLElement;
  private btnPlay: HTMLElement;
  private recorderEl: HTMLElement;
  private events: TimelineEvent[] = [];
  /** seq → dot element, for O(1) updates (defensive; main rarely re-sends). */
  private dots = new Map<number, HTMLElement>();
  /** seq → on-demand progress. Dropped on reset, setEvents, and eviction. */
  private progressCache = new Map<number, TimelineProgress>();
  /** seqs with an in-flight progress fetch. Prevents duplicate core calls. */
  private progressInFlight = new Set<number>();
  /** Invalidates progress requests when the visible project/timeline changes. */
  private progressEpoch = 0;
  private hoverSeq: number | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSeq: number | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private replayIdx = 0;

  private onJump: (ev: TimelineEvent, opts?: { replay?: boolean }) => void = () => {};
  private onFork: (ev: TimelineEvent) => void = () => {};
  private onProgress: (seq: number) => Promise<TimelineProgress> = async (seq) => ({ ok: false, seq });

  constructor(container: HTMLElement) {
    this.dotsEl = container.querySelector("#timeline-dots")!;
    this.countEl = container.querySelector("#timeline-count")!;
    this.prefixEl = container.querySelector("#timeline-prefix")!;
    this.recorderEl = container.querySelector("#timeline-recorder")!;
    this.btnPlay = container.querySelector("#btn-timeline-play")!;
    this.btnPlay.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleReplay();
    });
    container.addEventListener(
      "wheel",
      (e) => {
        if (this.dotsEl.scrollWidth <= this.dotsEl.clientWidth) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
          const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * this.dotsEl.clientWidth : e.deltaY;
          this.dotsEl.scrollLeft += delta;
          e.preventDefault();
        }
      },
      { passive: false },
    );
  }

  bind(handlers: {
    onJump: (ev: TimelineEvent, opts?: { replay?: boolean }) => void;
    onFork: (ev: TimelineEvent) => void;
    onProgress: (seq: number) => Promise<TimelineProgress>;
  }): void {
    this.onJump = handlers.onJump;
    this.onFork = handlers.onFork;
    this.onProgress = handlers.onProgress;
  }

  /** Clear timeline state when the project changes. */
  resetForProject(): void {
    this.setEvents([]);
    this.setRecorder("paused");
    this.setPrefix(null);
  }

  /** Last-tool counts for this run. Hidden when every count is zero. */
  setPrefix(p: Pick<TimelinePrefix, "ok" | "error" | "open"> | null): void {
    const total = p ? p.ok + p.error + p.open : 0;
    if (!p || total === 0) {
      this.prefixEl.hidden = true;
      this.prefixEl.textContent = "";
      this.prefixEl.removeAttribute("title");
      return;
    }
    const parts: string[] = [];
    if (p.ok) parts.push(`${p.ok} ok`);
    if (p.error) parts.push(`${p.error} error`);
    if (p.open) parts.push(`${p.open} open`);
    this.prefixEl.hidden = false;
    this.prefixEl.textContent = parts.join(" · ");
    this.prefixEl.title = "file tools in this run";
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
    if (seqs.length > 0) this.progressEpoch++;
    const gone = new Set(seqs);
    this.events = this.events.filter((e) => !gone.has(e.seq));
    for (const seq of seqs) {
      this.dots.get(seq)?.remove();
      this.dots.delete(seq);
      this.progressCache.delete(seq);
      this.progressInFlight.delete(seq);
    }
    this.countEl.textContent = this.events.length ? `(${this.events.length})` : "";
    this.btnPlay.hidden = this.events.length === 0;
  }

  setEvents(events: TimelineEvent[]): void {
    this.progressEpoch++;
    this.stopReplay();
    this.clearHover();
    this.progressCache.clear();
    this.progressInFlight.clear();
    this.events = events.slice(-MAX_TIMELINE_EVENTS);
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
        this.progressCache.delete(event.seq);
        this.progressInFlight.delete(event.seq);
      }
      return;
    }
    this.events.push(event);
    while (this.events.length > MAX_TIMELINE_EVENTS) {
      const removed = this.events.shift();
      if (removed) {
        this.dots.get(removed.seq)?.remove();
        this.dots.delete(removed.seq);
        this.progressCache.delete(removed.seq);
        this.progressInFlight.delete(removed.seq);
      }
    }
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
      const latest = this.eventBySeq(ev.seq) ?? ev;
      if ((e.metaKey || e.ctrlKey) && latest.stateId) {
        e.stopPropagation();
        this.forkAt(latest);
        return;
      }
      this.jumpTo(latest);
    });
    dot.addEventListener("pointerenter", () => this.scheduleProgress(ev.seq));
    dot.addEventListener("pointerleave", () => this.clearHover());
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

  private tooltip(ev: TimelineEvent, progress?: TimelineProgress): string {
    const time = new Date(ev.ts).toLocaleTimeString();
    const fork = ev.stateId ? " — Cmd/Ctrl+Click to fork at this moment" : ev.evicted ? " (source evicted)" : "";
    let base: string;
    switch (ev.t) {
      case "agent_start":
        base = `${time} — run started`;
        break;
      case "agent_settled":
        base = `${time} — run settled`;
        break;
      case "tool":
        base = `${time} — ${ev.toolName} ${ev.relPath ?? ""}${ev.content === undefined ? " (no snapshot)" : ""}${fork}`;
        break;
      case "change":
        base = `${time} — changed on disk: ${ev.relPath ?? ""}${fork}`;
        break;
    }
    return base + this.progressLine(progress);
  }

  private eventBySeq(seq: number): TimelineEvent | undefined {
    return this.events.find((e) => e.seq === seq);
  }

  private clearHover(): void {
    this.hoverSeq = null;
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  /** Fetch the source diff only for a forkable dot, and only on hover. */
  private scheduleProgress(seq: number): void {
    this.clearHover();
    this.hoverSeq = seq;
    const ev = this.eventBySeq(seq);
    if (!ev?.stateId || ev.evicted) return;
    const cached = this.progressCache.get(seq);
    if (cached) {
      const dot = this.dots.get(seq);
      if (dot) dot.title = this.tooltip(ev, cached);
      return;
    }
    if (this.progressInFlight.has(seq)) return;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      if (this.hoverSeq !== seq) return;
      if (this.progressInFlight.has(seq)) return;
      this.progressInFlight.add(seq);
      const epoch = this.progressEpoch;
      void this.onProgress(seq).then(
        (progress) => {
          if (this.progressEpoch !== epoch) return;
          this.progressInFlight.delete(seq);
          if (progress.ok) this.progressCache.set(seq, progress);
          if (this.hoverSeq !== seq) return;
          const latest = this.eventBySeq(seq);
          const dot = this.dots.get(seq);
          if (latest && dot) dot.title = this.tooltip(latest, progress);
        },
        () => {
          if (this.progressEpoch !== epoch) return;
          this.progressInFlight.delete(seq);
        },
      );
    }, 80);
  }

  private progressLine(progress?: TimelineProgress): string {
    if (!progress?.ok) return "";
    const n = progress.files ?? 0;
    if (n === 0) return " — no source changes from run start";
    const bits = [`${n} file${n === 1 ? "" : "s"}`];
    if (progress.created) bits.push(`${progress.created} created`);
    if (progress.modified) bits.push(`${progress.modified} modified`);
    if (progress.deleted) bits.push(`${progress.deleted} deleted`);
    const paths = progress.paths ?? [];
    const extra = paths.length ? `\n${paths.join("\n")}${n > paths.length ? "\n…" : ""}` : "";
    return ` — ${bits.join(" · ")}${extra}`;
  }

  /** Jump to a moment: open its snapshot via the bound handler. Content is
   *  fetched on demand by the handler, so every tool/change point jumps. */
  jumpTo(ev: TimelineEvent): void {
    this.stopReplay();
    this.highlight(ev.seq);
    if (ev.t === "tool" || ev.t === "change") this.onJump(ev);
    // Run markers do not open file snapshots.
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
