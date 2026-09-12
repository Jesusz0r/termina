/**
 * Session Timeline: a compact strip under the terminal
 * showing every agent action with a dot. Clicking a dot opens the file as it
 * looked at that exact moment (read-only snapshot tab); ▶ replays the run.
 * A forkable dot (captured source state) forks a candidate at that moment
 * with Cmd/Ctrl+Click. Keyboard: Tab enters the strip once (roving tabindex),
 * arrows/Home/End move the selection, Enter/Space open the moment,
 * Cmd/Ctrl+Enter forks it, Escape stops a replay.
 */
import type { TimelineEvent, RecorderState, TimelinePrefix, TimelineProgress } from "../shared/types";

export const MAX_TIMELINE_EVENTS = 400;

/** Arrow target inside the strip: clamped at the ends (a timeline reads in
 *  order, so wrapping past the newest moment would be a lie). `null` when the
 *  move would leave the strip. */
export function stepTimelineIndex(count: number, index: number, delta: -1 | 1): number | null {
  if (index < 0 || index >= count) return null;
  const next = index + delta;
  return next < 0 || next >= count ? null : next;
}

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
  /** The one dot with tabindex 0 (roving): the selection, else the newest. */
  private tabStopSeq: number | null = null;
  private replayTimer: ReturnType<typeof setInterval> | null = null;
  private replayIdx = 0;

  private onJump: (ev: TimelineEvent, opts?: { replay?: boolean }) => void = () => {};
  private onFork: (ev: TimelineEvent) => void = () => {};
  private onProgress: (seq: number) => Promise<TimelineProgress> = async (seq) => ({ ok: false, seq });
  private onContent: (has: boolean, count: number) => void = () => {};

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
    container.addEventListener("keydown", (e) => this.onKeydown(e));
    // Replay keeps opening snapshots after focus leaves the strip; Esc must
    // still stop it, except in the terminal (agent TUI) or a nested modal.
    document.addEventListener("keydown", this.onDocumentKeydown);
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
    /** Badge + empty-copy sync. Timeline never auto-switches the tab. */
    onContent?: (has: boolean, count: number) => void;
  }): void {
    this.onJump = handlers.onJump;
    this.onFork = handlers.onFork;
    this.onProgress = handlers.onProgress;
    this.onContent = handlers.onContent ?? (() => {});
  }

  private reportContent(): void {
    this.onContent(this.events.length > 0, this.events.length);
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
  setRecorder(state: RecorderState, detail?: string | null): void {
    this.recorderEl.textContent = state === "ready" ? "" : state;
    this.recorderEl.className = `timeline-recorder rec-${state}`;
    this.recorderEl.hidden = state === "ready";
    const base =
      state === "indexing"
        ? "indexing the source for moment forking"
        : state === "paused"
          ? "moment forking is paused (no Git recording)"
          : state === "degraded"
            ? "some moments could not be captured"
            : "the fork-point budget is evicting old moments";
    this.recorderEl.title = state === "degraded" && detail ? `${base}: ${detail}` : base;
  }

  /** Drop evicted dots (their source states are gone). */
  evict(seqs: number[]): void {
    if (seqs.length > 0) this.progressEpoch++;
    const gone = new Set(seqs);
    const hadDotFocus = this.timelineHasDotFocus();
    this.events = this.events.filter((e) => !gone.has(e.seq));
    for (const seq of seqs) {
      this.dots.get(seq)?.remove();
      this.dots.delete(seq);
      this.progressCache.delete(seq);
      this.progressInFlight.delete(seq);
    }
    if (this.activeSeq !== null && gone.has(this.activeSeq)) this.activeSeq = null;
    if (this.tabStopSeq !== null && gone.has(this.tabStopSeq)) this.setTabStop(this.activeSeq ?? this.newestSeq());
    this.restoreTimelineFocus(hadDotFocus);
    this.countEl.textContent = this.events.length ? `(${this.events.length})` : "";
    this.btnPlay.hidden = this.events.length === 0;
    this.reportContent();
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
        this.setDotLabel(existing, event);
        this.progressCache.delete(event.seq);
        this.progressInFlight.delete(event.seq);
      }
      return;
    }
    this.events.push(event);
    const hadDotFocus = this.timelineHasDotFocus();
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
    if (this.activeSeq !== null && !this.dots.has(this.activeSeq)) this.activeSeq = null;
    if (event.seq === this.activeSeq) this.markActive(dot, true);
    // With no selection the newest dot is the strip's single tab stop.
    // A cap eviction of the current stop (Home on the oldest, then 400 more)
    // must not leave the strip without a tabbable dot.
    if (this.tabStopSeq === null || !this.dots.has(this.tabStopSeq)) {
      this.setTabStop(this.activeSeq ?? this.newestSeq());
    } else if (this.activeSeq === null) {
      this.setTabStop(event.seq);
    }
    this.restoreTimelineFocus(hadDotFocus);
    this.countEl.textContent = `(${this.events.length})`;
    this.btnPlay.hidden = this.events.length === 0;
    this.reportContent();
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
      this.markActive(el, on);
      if (on) activeEl = el;
    }
    this.setTabStop(seq);
    // Center the active dot: replay steps beyond the visible strip width.
    if (activeEl) {
      const left = activeEl.offsetLeft - this.dotsEl.clientWidth / 2;
      this.dotsEl.scrollLeft = Math.max(0, left);
    }
  }

  /** Selection chrome on one dot: the CSS class plus its ARIA state. */
  private markActive(el: HTMLElement, on: boolean): void {
    el.classList.toggle("active", on);
    if (on) el.setAttribute("aria-current", "true");
    else el.removeAttribute("aria-current");
  }

  private dotClass(ev: TimelineEvent): string {
    return `timeline-dot t-${ev.t}${ev.toolName ? ` tool-${ev.toolName}` : ""}${ev.stateId ? " forkable" : ev.evicted ? " evicted" : ""}`;
  }

  private makeDot(ev: TimelineEvent): HTMLElement {
    const dot = document.createElement("span");
    dot.className = this.dotClass(ev);
    dot.dataset.seq = String(ev.seq);
    // A dot is a button in a toolbar: arrows move between moments, Tab
    // enters the strip once (roving tabindex), Enter/Space open the moment.
    this.setDotLabel(dot, ev);
    dot.setAttribute("role", "button");
    dot.tabIndex = -1;
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
    // Keyboard parity with hover: focusing a forkable dot fetches its diff.
    dot.addEventListener("focus", () => this.scheduleProgress(ev.seq));
    dot.addEventListener("blur", () => this.clearHover());
    return dot;
  }

  /** Keep exactly one dot tabbable, so Tab enters the strip instead of
   *  walking every moment. A seq that is no longer rendered falls back to the
   *  newest dot, so the strip is never left without a stop. O(1). */
  private setTabStop(seq: number | null): void {
    const target = seq !== null && this.dots.has(seq) ? seq : this.newestSeq();
    if (this.tabStopSeq === target) return;
    if (this.tabStopSeq !== null) {
      const previous = this.dots.get(this.tabStopSeq);
      if (previous) previous.tabIndex = -1;
    }
    this.tabStopSeq = target;
    if (target !== null) {
      const next = this.dots.get(target);
      if (next) next.tabIndex = 0;
    }
  }

  /** The dot the strip falls back to when nothing is selected: the newest. */
  private newestSeq(): number | null {
    return this.events.length > 0 ? this.events[this.events.length - 1].seq : null;
  }

  /** Title and aria-label stay in lockstep (hover tooltip + keyboard name). */
  private setDotLabel(dot: HTMLElement, ev: TimelineEvent, progress?: TimelineProgress): void {
    const label = this.tooltip(ev, progress);
    dot.title = label;
    dot.setAttribute("aria-label", label);
  }

  /** True when a still-mounted timeline dot owns keyboard focus. */
  private timelineHasDotFocus(): boolean {
    const el = document.activeElement;
    return el instanceof HTMLElement && el.classList.contains("timeline-dot") && this.dotsEl.contains(el);
  }

  /** If a removed dot had focus, land on the tab stop. Removing the focused
   *  node first leaves `document.activeElement` on `body`, so callers snapshot
   *  `timelineHasDotFocus()` before the detach. */
  private restoreTimelineFocus(hadDotFocus: boolean): void {
    if (!hadDotFocus) return;
    if (this.timelineHasDotFocus()) return;
    if (this.tabStopSeq !== null) this.dots.get(this.tabStopSeq)?.focus({ preventScroll: true });
  }

  /** Move focus and the selection to a moment, without opening it. */
  private focusSeq(seq: number): void {
    this.highlight(seq);
    this.dots.get(seq)?.focus({ preventScroll: true });
  }

  private activate(ev: TimelineEvent, fork: boolean): void {
    if (fork && ev.stateId) this.forkAt(ev);
    else this.jumpTo(ev);
  }

  /** Esc stops a replay from anywhere except the terminal, a nested modal,
   *  or Change Review (those surfaces already own the key). */
  private onDocumentKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || e.defaultPrevented || !this.replayTimer) return;
    const target = e.target;
    if (
      target instanceof Element
      && (target.closest("#terminal-container") || target.closest("#modal-root") || target.closest("#review-container"))
    ) return;
    e.preventDefault();
    this.stopReplay();
  };

  /** Strip keyboard: arrows/Home/End move the selection, Enter/Space open
   *  the moment, Cmd/Ctrl+Enter forks it. Escape is handled on document. */
  private onKeydown(e: KeyboardEvent): void {
    const target = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>(".timeline-dot") : null;
    const seq = target ? Number(target.dataset.seq) : NaN;
    const idx = this.events.findIndex((ev) => ev.seq === seq);
    if (idx === -1) return;
    let to: number | null;
    switch (e.key) {
      case "ArrowLeft":
        to = stepTimelineIndex(this.events.length, idx, -1);
        break;
      case "ArrowRight":
        to = stepTimelineIndex(this.events.length, idx, 1);
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = this.events.length - 1;
        break;
      case "Enter":
      case " ": {
        const ev = this.eventBySeq(seq);
        if (!ev) return;
        e.preventDefault();
        this.activate(ev, e.metaKey || e.ctrlKey);
        return;
      }
      default:
        return;
    }
    e.preventDefault();
    const next = to === null ? undefined : this.events[to];
    if (next) this.focusSeq(next.seq);
  }

  private render(): void {
    const n = this.events.length;
    this.countEl.textContent = n ? `(${n})` : "";
    this.btnPlay.hidden = n === 0;
    this.dotsEl.replaceChildren();
    this.dots.clear();
    this.tabStopSeq = null;
    for (const ev of this.events) {
      const dot = this.makeDot(ev);
      this.dots.set(ev.seq, dot);
      if (ev.seq === this.activeSeq) this.markActive(dot, true);
      this.dotsEl.appendChild(dot);
    }
    this.setTabStop(this.activeSeq ?? this.newestSeq());
    // Keep the newest dot in view — but only when the user is already near
    // the end, so new events do not pull the view away from an old moment.
    const nearEnd = this.dotsEl.scrollLeft + this.dotsEl.clientWidth >= this.dotsEl.scrollWidth - 24;
    if (n > 0 && nearEnd) this.dotsEl.scrollLeft = this.dotsEl.scrollWidth;
    this.reportContent();
  }

  private tooltip(ev: TimelineEvent, progress?: TimelineProgress): string {
    const time = new Date(ev.ts).toLocaleTimeString();
    const fork = ev.stateId ? " — Cmd/Ctrl+Click or Cmd/Ctrl+Enter to fork at this moment" : ev.evicted ? " (source evicted)" : "";
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
      if (dot) this.setDotLabel(dot, ev, cached);
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
          if (latest && dot) this.setDotLabel(dot, latest, progress);
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
