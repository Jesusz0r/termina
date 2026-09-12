/**
 * Activity tabs (HARNESS-BACKLOG #1): the left pane below the terminal used
 * to stack Timeline, Plan, Worldlines, and Modified, squeezing the pty on
 * small screens. One tab shows at a time; the rest are badges.
 *
 * State transitions are a pure reducer (node-testable); the class below is
 * thin DOM glue over it. Content arrivals auto-switch on the empty →
 * non-empty edge for plan/worldlines/modified only — timeline dots stream
 * continuously and must never yank the tab. A selected unused tab shows
 * the `[data-empty]` sentence in that panel; content hides it.
 */

export type ActivityTab = "timeline" | "plan" | "worldlines" | "modified";

export const ACTIVITY_TABS: readonly ActivityTab[] = ["timeline", "plan", "worldlines", "modified"];

export const ACTIVITY_TAB_KEY = "termina.activityTab";

export interface ActivityTabState {
  active: ActivityTab;
  content: Record<ActivityTab, boolean>;
  visible: Record<ActivityTab, boolean>;
}

export type ActivityTabEvent =
  | { type: "select"; tab: ActivityTab }
  | { type: "content"; tab: ActivityTab; has: boolean }
  | { type: "sync"; tab: ActivityTab; has: boolean }
  | { type: "visibility"; tab: ActivityTab; visible: boolean };

const ALL_TRUE: Record<ActivityTab, boolean> = { timeline: true, plan: true, worldlines: true, modified: true };
const ALL_FALSE: Record<ActivityTab, boolean> = { timeline: false, plan: false, worldlines: false, modified: false };

export function initialActivityTabState(active: ActivityTab): ActivityTabState {
  return { active, content: { ...ALL_FALSE }, visible: { ...ALL_TRUE } };
}

/** Stored value → tab, falling back to timeline for anything unexpected. */
export function resolveActivityTab(stored: unknown): ActivityTab {
  return stored === "plan" || stored === "worldlines" || stored === "modified" ? stored : "timeline";
}

/** Why-empty copy shows only on the selected tab when that tab has no content. */
export function activityEmptyVisible(state: ActivityTabState, tab: ActivityTab): boolean {
  return state.active === tab && !state.content[tab];
}

export function reduceActivityTab(state: ActivityTabState, event: ActivityTabEvent): ActivityTabState {
  switch (event.type) {
    case "select": {
      if (!state.visible[event.tab] || state.active === event.tab) return state;
      return { ...state, active: event.tab };
    }
    case "content": {
      if (state.content[event.tab] === event.has) return state;
      const content = { ...state.content, [event.tab]: event.has };
      // New arrivals become visible, like the old un-collapse. Timeline
      // streams dots constantly, so it never auto-switches.
      const auto = event.has && event.tab !== "timeline" && state.visible[event.tab];
      return { ...state, content, active: auto ? event.tab : state.active };
    }
    case "sync": {
      // Badge + state only, for re-renders that must not yank the tab
      // (terminal/project switches redisplaying existing content).
      if (state.content[event.tab] === event.has) return state;
      return { ...state, content: { ...state.content, [event.tab]: event.has } };
    }
    case "visibility": {
      if (state.visible[event.tab] === event.visible) return state;
      const visible = { ...state.visible, [event.tab]: event.visible };
      const active = !event.visible && state.active === event.tab ? "timeline" : state.active;
      return { ...state, visible, active };
    }
  }
}

export interface ActivityTabsDeps {
  bar: HTMLElement;
  panels: Record<ActivityTab, HTMLElement>;
  counts: Record<ActivityTab, HTMLElement | null>;
  storage?: Pick<Storage, "getItem" | "setItem">;
}

export class ActivityTabs {
  private state: ActivityTabState;
  private readonly deps: ActivityTabsDeps;
  private readonly buttons = new Map<ActivityTab, HTMLButtonElement>();
  private readonly empties = new Map<ActivityTab, HTMLElement>();

  constructor(deps: ActivityTabsDeps) {
    this.deps = deps;
    let stored: string | null = null;
    try {
      stored = deps.storage?.getItem(ACTIVITY_TAB_KEY) ?? null;
    } catch {
      stored = null;
    }
    this.state = initialActivityTabState(resolveActivityTab(stored));
    for (const tab of ACTIVITY_TABS) {
      const button = deps.bar.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`);
      if (button) {
        this.buttons.set(tab, button);
        button.addEventListener("click", () => this.select(tab));
      }
      const empty = deps.panels[tab]?.querySelector<HTMLElement>("[data-empty]");
      if (empty) this.empties.set(tab, empty);
    }
    this.apply();
  }

  get active(): ActivityTab {
    return this.state.active;
  }

  select(tab: ActivityTab): void {
    const next = reduceActivityTab(this.state, { type: "select", tab });
    if (next === this.state) return;
    this.state = next;
    this.persist();
    this.apply();
  }

  /** Content arrival + badge count. Auto-switches on the empty → non-empty edge. */
  setHasContent(tab: ActivityTab, has: boolean, count: number): void {
    this.update(tab, count, { type: "content", tab, has });
  }

  /** Badge + state without switching (re-rendering existing content). */
  syncContent(tab: ActivityTab, has: boolean, count: number): void {
    this.update(tab, count, { type: "sync", tab, has });
  }

  private update(tab: ActivityTab, count: number, event: ActivityTabEvent): void {
    const next = reduceActivityTab(this.state, event);
    const countEl = this.deps.counts[tab];
    if (countEl) countEl.textContent = count > 0 ? `(${count})` : "";
    if (next === this.state) return;
    const switched = next.active !== this.state.active;
    this.state = next;
    if (switched) this.persist();
    this.apply();
  }

  setTabVisible(tab: ActivityTab, visible: boolean): void {
    const next = reduceActivityTab(this.state, { type: "visibility", tab, visible });
    if (next === this.state) return;
    this.state = next;
    this.apply();
  }

  private persist(): void {
    try {
      this.deps.storage?.setItem(ACTIVITY_TAB_KEY, this.state.active);
    } catch {
      /* private-mode writes fail; the tab still works for the session */
    }
  }

  private apply(): void {
    for (const tab of ACTIVITY_TABS) {
      this.deps.panels[tab]?.classList.toggle("tab-active", this.state.active === tab);
      const button = this.buttons.get(tab);
      button?.classList.toggle("active", this.state.active === tab);
      if (button) {
        button.hidden = !this.state.visible[tab];
        button.setAttribute("aria-selected", this.state.active === tab ? "true" : "false");
      }
      const empty = this.empties.get(tab);
      if (empty) empty.hidden = !activityEmptyVisible(this.state, tab);
    }
  }
}
