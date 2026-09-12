/**
 * Activity tabs (HARNESS-BACKLOG #1): the left pane below the terminal used
 * to stack Timeline, Plan, Worldlines, and Modified, squeezing the pty on
 * small screens. One tab shows at a time; the rest are badges.
 *
 * State transitions are a pure reducer (node-testable); the class below is
 * thin DOM glue over it. Content arrivals auto-switch on the empty →
 * non-empty edge for plan/worldlines/modified only — timeline dots stream
 * continuously and must never yank the tab. A tab the user picked by hand is
 * held: it outranks that auto-switch, so a run cannot steal the panel the
 * user is watching (the count badge still announces the new content). A
 * selected unused tab shows the `[data-empty]` sentence in that panel;
 * content hides it. Keyboard: one tab stop (roving tabindex) plus
 * arrows/Home/End along the visible tabs.
 */

export type ActivityTab = "timeline" | "plan" | "worldlines" | "modified";

export const ACTIVITY_TABS: readonly ActivityTab[] = ["timeline", "plan", "worldlines", "modified"];

export const ACTIVITY_TAB_LABELS: Record<ActivityTab, string> = {
  timeline: "Timeline",
  plan: "Plan",
  worldlines: "Worldlines",
  modified: "Modified",
};

export const ACTIVITY_TAB_KEY = "termina.activityTab";

/** Panel chrome repeats the tab name only when the tab bar is gone. */
export function activityPanelTitleVisible(tabBarVisible: boolean): boolean {
  return !tabBarVisible;
}

export interface ActivityTabState {
  active: ActivityTab;
  content: Record<ActivityTab, boolean>;
  visible: Record<ActivityTab, boolean>;
  /** The tab the user picked by hand (click, or an arrow key), if any. An
   *  explicit choice outranks the content auto-switch; re-picking the active
   *  tab re-arms it. Null until the user picks, and again once that tab is
   *  hidden — the restored tab on launch is a preference, not a fresh choice. */
  held: ActivityTab | null;
}

export type ActivityTabEvent =
  | { type: "select"; tab: ActivityTab }
  | { type: "content"; tab: ActivityTab; has: boolean }
  | { type: "sync"; tab: ActivityTab; has: boolean }
  | { type: "visibility"; tab: ActivityTab; visible: boolean };

const ALL_TRUE: Record<ActivityTab, boolean> = { timeline: true, plan: true, worldlines: true, modified: true };
const ALL_FALSE: Record<ActivityTab, boolean> = { timeline: false, plan: false, worldlines: false, modified: false };

export function initialActivityTabState(active: ActivityTab): ActivityTabState {
  return { active, content: { ...ALL_FALSE }, visible: { ...ALL_TRUE }, held: null };
}

/** Stored value → tab, falling back to timeline for anything unexpected. */
export function resolveActivityTab(stored: unknown): ActivityTab {
  return stored === "plan" || stored === "worldlines" || stored === "modified" ? stored : "timeline";
}

/** The tabs a user can reach: a hidden tab (this terminal or project has no
 *  such surface) leaves the arrow-key order. */
export function visibleActivityTabs(state: ActivityTabState): ActivityTab[] {
  return ACTIVITY_TABS.filter((tab) => state.visible[tab]);
}

/** The tab one arrow step from `from`, wrapping at either end. Stays put when
 *  there is nowhere to go. */
export function stepActivityTab(tabs: readonly ActivityTab[], from: ActivityTab, delta: -1 | 1): ActivityTab {
  const idx = tabs.indexOf(from);
  if (idx === -1 || tabs.length < 2) return from;
  return tabs[(idx + delta + tabs.length) % tabs.length] ?? from;
}

/** Why-empty copy shows only on the selected tab when that tab has no content. */
export function activityEmptyVisible(state: ActivityTabState, tab: ActivityTab): boolean {
  return state.active === tab && !state.content[tab];
}

export function reduceActivityTab(state: ActivityTabState, event: ActivityTabEvent): ActivityTabState {
  switch (event.type) {
    case "select": {
      if (!state.visible[event.tab]) return state;
      // Picking the tab that is already active still arms the hold (the user
      // just said "stay here"), so only the hold moves.
      if (state.active === event.tab) return state.held === event.tab ? state : { ...state, held: event.tab };
      return { ...state, active: event.tab, held: event.tab };
    }
    case "content": {
      if (state.content[event.tab] === event.has) return state;
      const content = { ...state.content, [event.tab]: event.has };
      // New arrivals become visible, like the old un-collapse. Timeline
      // streams dots constantly, so it never auto-switches; a tab the user
      // picked by hand holds until they pick another.
      const auto =
        event.has && event.tab !== "timeline" && state.visible[event.tab] && state.active !== state.held;
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
      const held = !event.visible && state.held === event.tab ? null : state.held;
      return { ...state, visible, active, held };
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
    // WAI-ARIA tabs: arrows move along the visible tabs and the panel follows
    // the focus (selection follows focus — switching is instant here).
    deps.bar.addEventListener("keydown", (event) => this.onKeydown(event));
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

  /** Arrow/Home/End move along the visible tabs (WAI-ARIA tabs pattern). */
  private onKeydown(event: KeyboardEvent): void {
    const from = this.tabOf(event.target);
    if (!from) return;
    const tabs = visibleActivityTabs(this.state);
    let next: ActivityTab | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      next = stepActivityTab(tabs, from, event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === "Home") {
      next = tabs[0] ?? null;
    } else if (event.key === "End") {
      next = tabs[tabs.length - 1] ?? null;
    }
    if (!next) return;
    event.preventDefault();
    this.select(next);
    this.buttons.get(next)?.focus();
  }

  /** The tab whose button holds the event target (the keydown lands on the
   *  button or on the count span inside it). */
  private tabOf(target: EventTarget | null): ActivityTab | null {
    if (!(target instanceof Element)) return null;
    for (const [tab, button] of this.buttons) {
      if (button.contains(target)) return tab;
    }
    return null;
  }

  private writeCount(tab: ActivityTab, count: number): void {
    const label = count > 0 ? `(${count})` : "";
    const countEl = this.deps.counts[tab];
    if (countEl) countEl.textContent = label;
    const badge = this.buttons.get(tab)?.querySelector<HTMLElement>(".activity-count");
    if (badge) badge.textContent = label;
  }

  private update(tab: ActivityTab, count: number, event: ActivityTabEvent): void {
    const next = reduceActivityTab(this.state, event);
    this.writeCount(tab, count);
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
    const tabBarVisible = !this.deps.bar.hidden;
    const repeatTitle = activityPanelTitleVisible(tabBarVisible);
    for (const tab of ACTIVITY_TABS) {
      const panel = this.deps.panels[tab];
      panel?.classList.toggle("tab-active", this.state.active === tab);
      const button = this.buttons.get(tab);
      button?.classList.toggle("active", this.state.active === tab);
      if (button) {
        button.hidden = !this.state.visible[tab];
        // Roving tabindex: Tab enters the bar at the selected tab, arrows move.
        button.tabIndex = this.state.active === tab ? 0 : -1;
        button.setAttribute("aria-selected", this.state.active === tab ? "true" : "false");
        if (!button.id) button.id = `activity-tab-${tab}`;
      }
      if (panel) {
        panel.toggleAttribute("data-repeat-title", repeatTitle);
        panel.setAttribute("role", "tabpanel");
        if (button) {
          if (panel.id) button.setAttribute("aria-controls", panel.id);
          panel.setAttribute("aria-labelledby", button.id);
        }
      }
      const empty = this.empties.get(tab);
      if (empty) empty.hidden = !activityEmptyVisible(this.state, tab);
    }
  }
}
