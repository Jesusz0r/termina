/**
 * Timeline pane: session timeline strip with per-pane fetch, merge, and trim.
 * Owns the TimelineView instance, jump epoch, render logic, and timeline IPC.
 * Main wires pane/project/editor callbacks; all timeline state lives here.
 */
import { MAX_TIMELINE_EVENTS, TimelineView } from "../timeline";
import { toast } from "../components/modals";
import type { TimelineEvent, TimelinePrefix } from "../../shared/types";

export interface TimelinePaneState {
  instanceId: string;
  timeline: TimelineEvent[];
  timelineLoaded: boolean;
  timelineRequestToken: number;
  timelinePrefix: Pick<TimelinePrefix, "ok" | "error" | "open"> | null;
  recorderState: string;
  recorderDetail: string | null;
}

export interface TimelinePaneProject {
  id: string | null;
  generation: number;
}

export interface TimelinePaneEditor {
  openSnapshot(terminalId: string, eventKey: string, relPath: string, content: string, label: string, replay?: boolean): void;
}

export interface TimelinePaneBindings<TPane extends TimelinePaneState> {
  container: HTMLElement;
  getActivePane(): TPane | undefined;
  getActivePaneId(): string | null;
  getPaneById(id: string): TPane | undefined;
  getActiveProject(): TimelinePaneProject;
  getEditor(): TimelinePaneEditor;
  onContent(has: boolean, count: number): void;
  onAgentSettled(pane: TPane): void;
  onTimelineCleared(pane: TPane): void;
}

export function createTimelinePane<TPane extends TimelinePaneState>(
  bindings: TimelinePaneBindings<TPane>,
): {
  view: TimelineView;
  renderTimeline(): void;
  resetForProject(): void;
  invalidateJumps(): void;
  dispose(): void;
} {
  const view = new TimelineView(bindings.container);
  let jumpEpoch = 0;

  /** Session Timeline: show the active pane's points, fetch once per pane. */
  function renderTimeline(): void {
    const pane = bindings.getActivePane();
    if (!pane) {
      view.setEvents([]);
      return;
    }
    view.setRecorder(pane.recorderState as Parameters<typeof view.setRecorder>[0], pane.recorderDetail);
    view.setPrefix(pane.timelinePrefix);
    if (!pane.timelineLoaded) {
      const id = pane.instanceId;
      const requestedProjectId = bindings.getActiveProject().id;
      const requestedGeneration = bindings.getActiveProject().generation;
      const requestToken = ++pane.timelineRequestToken;
      pane.timelineLoaded = true;
      void window.termina.getTimeline(id).then((events) => {
        const p = bindings.getPaneById(id);
        if (!p) return;
        if (p !== pane || p.timelineRequestToken !== requestToken) return;
        const current = bindings.getActiveProject();
        if (current.id !== requestedProjectId || current.generation !== requestedGeneration) {
          p.timelineLoaded = false;
          return;
        }
        const maxSeq = events.length ? Math.max(...events.map((e) => e.seq)) : 0;
        p.timeline = events.concat(p.timeline.filter((e) => e.seq > maxSeq)).slice(-MAX_TIMELINE_EVENTS);
        if (bindings.getActivePaneId() === id) view.setEvents(p.timeline);
      }).catch((err) => {
        const p = bindings.getPaneById(id);
        if (!p || p !== pane || p.timelineRequestToken !== requestToken) return;
        const current = bindings.getActiveProject();
        if (current.id !== requestedProjectId || current.generation !== requestedGeneration) {
          p.timelineLoaded = false;
          return;
        }
        p.timelineLoaded = false;
        toast(`could not load timeline: ${(err as Error).message}`, "error");
      });
      void window.termina.getTimelinePrefix(id).then((prefix) => {
        const p = bindings.getPaneById(id);
        if (!p || p !== pane || p.timelineRequestToken !== requestToken) return;
        const current = bindings.getActiveProject();
        if (current.id !== requestedProjectId || current.generation !== requestedGeneration) return;
        p.timelinePrefix = prefix;
        if (bindings.getActivePaneId() === id) view.setPrefix(prefix);
      }).catch((err) => {
        const p = bindings.getPaneById(id);
        if (!p || p !== pane || p.timelineRequestToken !== requestToken) return;
        const current = bindings.getActiveProject();
        if (current.id !== requestedProjectId || current.generation !== requestedGeneration) return;
        toast(`could not load timeline counts: ${(err as Error).message}`, "error");
      });
      return;
    }
    view.setEvents(pane.timeline);
  }

  view.bind({
    onJump: async (ev, opts) => {
      const pane = bindings.getActivePane();
      if (!pane) return;
      const epoch = ++jumpEpoch;
      const terminalId = pane.instanceId;
      const projectId = bindings.getActiveProject().id;
      const editor = bindings.getEditor();
      const isCurrent = (): boolean =>
        epoch === jumpEpoch
        && bindings.getActivePaneId() === terminalId
        && bindings.getActiveProject().id === projectId
        && bindings.getEditor() === editor;
      // Snapshots are fetched on demand — the strip/IPC never carries content.
      let res = await window.termina.getTimelineContent(pane.instanceId, ev.seq);
      if (!isCurrent()) return;
      // A write snapshot may still be filling in (the delayed fill takes
      // 400 milliseconds) — retry
      // briefly before giving up.
      for (let i = 0; i < 5 && !res.ok; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!isCurrent()) return;
        res = await window.termina.getTimelineContent(pane.instanceId, ev.seq);
        if (!isCurrent()) return;
      }
      if (!res.ok) {
        const what = ev.t === "change" ? "change" : ev.toolName ?? "event";
        toast(`${what} ${res.relPath ?? ev.relPath ?? ""} — no snapshot for this moment`, "info");
        return;
      }
      const label = `${new Date(res.ts ?? ev.ts).toLocaleTimeString()} · ${res.toolName ?? ev.toolName ?? "on disk"}`;
      editor.openSnapshot(pane.instanceId, String(ev.seq), res.relPath ?? res.path ?? "", res.content ?? "", label, opts?.replay ?? false);
    },
    onFork: (ev) => {
      const pane = bindings.getActivePane();
      if (!pane) return;
      if (!ev.stateId) {
        toast("this moment is not forkable yet", "warning");
        return;
      }
      void window.termina.forkPoint(pane.instanceId, ev.seq).then((res) => {
        // Success needs no toast: the new candidate cards are the confirmation.
        if (!res.ok) toast(`fork at this moment failed: ${res.error ?? "unknown error"}`, "warning");
      });
    },
    onProgress: (seq) => {
      const pane = bindings.getActivePane();
      if (!pane) return Promise.resolve({ ok: false, seq });
      const requestedProjectId = bindings.getActiveProject().id;
      const requestedGeneration = bindings.getActiveProject().generation;
      return window.termina.getTimelineProgress(pane.instanceId, seq).then((progress) => {
        const current = bindings.getActiveProject();
        if (current.id !== requestedProjectId || current.generation !== requestedGeneration || bindings.getActivePaneId() !== pane.instanceId) {
          return { ok: false, seq };
        }
        return progress;
      });
    },
    onContent: (has, count) => {
      bindings.onContent(has, count);
    },
  });

  const unsubs = [
    window.termina.onTimelineEvent(({ terminalId, event }) => {
      const pane = bindings.getPaneById(terminalId);
      if (!pane) return;
      // Updates from main re-use the seq — replace in place, never duplicate.
      const idx = pane.timeline.findIndex((e) => e.seq === event.seq);
      if (idx === -1) pane.timeline.push(event);
      else pane.timeline[idx] = event;
      if (pane.timeline.length > MAX_TIMELINE_EVENTS) pane.timeline.splice(0, pane.timeline.length - MAX_TIMELINE_EVENTS);
      if (bindings.getActivePaneId() === terminalId) view.push(event);
      // A settled run may have become forkable: refresh the Fork Run button.
      if (event.t === "agent_settled") bindings.onAgentSettled(pane);
    }),
    window.termina.onTimelineEvict(({ terminalId, seqs }) => {
      const pane = bindings.getPaneById(terminalId);
      if (!pane) return;
      pane.timeline = pane.timeline.filter((e) => !seqs.includes(e.seq));
      if (bindings.getActivePaneId() === terminalId) view.evict(seqs);
    }),
    window.termina.onTimelineClear(({ terminalId }) => {
      const pane = bindings.getPaneById(terminalId);
      if (!pane) return;
      pane.timeline = [];
      pane.timelinePrefix = null;
      if (bindings.getActivePaneId() === terminalId) {
        view.setEvents([]);
        view.setPrefix(null);
      }
      bindings.onTimelineCleared(pane);
    }),
    window.termina.onTimelinePrefix((p) => {
      const pane = bindings.getPaneById(p.terminalId);
      if (!pane) return;
      pane.timelinePrefix = p;
      if (bindings.getActivePaneId() === p.terminalId) view.setPrefix(p);
    }),
    window.termina.onRecorderState(({ terminalId, state, detail }) => {
      const pane = bindings.getPaneById(terminalId);
      if (!pane) return;
      pane.recorderState = state;
      pane.recorderDetail = detail ?? null;
      if (bindings.getActivePaneId() === terminalId) view.setRecorder(state, detail ?? null);
    }),
  ];

  function resetForProject(): void {
    view.resetForProject();
  }

  function invalidateJumps(): void {
    jumpEpoch++;
  }

  function dispose(): void {
    for (const unsub of unsubs) unsub();
  }

  return { view, renderTimeline, resetForProject, invalidateJumps, dispose };
}
