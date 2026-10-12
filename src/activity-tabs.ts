/**
 * On-demand tools below the canonical terminal. Only explicit selection opens
 * a panel; content arrivals update badges without opening or switching tools.
 * Closing retains the selected tool and its content. Keyboard: one tab stop,
 * arrows/Home/End across visible tabs, and Escape from a tool back to its tab.
 */

type ActivityTab = "timeline" | "plan" | "worldlines" | "modified" | "checks";

export const ACTIVITY_TABS: readonly ActivityTab[] = ["checks", "timeline", "plan", "worldlines", "modified"];

const ACTIVITY_TAB_KEY = "termina.activityTab";

/** Panel chrome repeats the tab name only when the tab bar is gone. */
export function activityPanelTitleVisible(tabBarVisible: boolean): boolean {
  return !tabBarVisible;
}

interface ActivityTabState {
  active: ActivityTab;
  content: Record<ActivityTab, boolean>;
  visible: Record<ActivityTab, boolean>;
  open: boolean;
}

type ActivityTabEvent =
  | { type: "select"; tab: ActivityTab }
  | { type: "content"; tab: ActivityTab; has: boolean }
  | { type: "close" }
  | { type: "visibility"; tab: ActivityTab; visible: boolean };

const ALL_TRUE: Record<ActivityTab, boolean> = { checks: true, timeline: true, plan: true, worldlines: true, modified: true };
const ALL_FALSE: Record<ActivityTab, boolean> = { checks: false, timeline: false, plan: false, worldlines: false, modified: false };

export function initialActivityTabState(active: ActivityTab): ActivityTabState {
  return { active, content: { ...ALL_FALSE }, visible: { ...ALL_TRUE }, open: false };
}

/** Stored value → tab, falling back to timeline for anything unexpected. */
export function resolveActivityTab(stored: unknown): ActivityTab {
  return stored === "checks" || stored === "plan" || stored === "worldlines" || stored === "modified" ? stored : "timeline";
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
  return state.open && state.active === tab && !state.content[tab];
}

export function reduceActivityTab(state: ActivityTabState, event: ActivityTabEvent): ActivityTabState {
  switch (event.type) {
    case "select": {
      if (!state.visible[event.tab]) return state;
      if (state.active === event.tab && state.open) return state;
      return { ...state, active: event.tab, open: true };
    }
    case "content": {
      if (state.content[event.tab] === event.has) return state;
      return { ...state, content: { ...state.content, [event.tab]: event.has } };
    }
    case "close": return state.open ? { ...state, open: false } : state;
    case "visibility": {
      if (state.visible[event.tab] === event.visible) return state;
      const visible = { ...state.visible, [event.tab]: event.visible };
      const active = !event.visible && state.active === event.tab ? "timeline" : state.active;
      return { ...state, visible, active };
    }
  }
}

interface ActivityTabsDeps {
  bar: HTMLElement;
  closeButton: HTMLButtonElement;
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
    deps.closeButton.addEventListener("click", () => this.close());
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || !this.state.open) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    };
    deps.bar.addEventListener("keydown", onEscape);
    deps.closeButton.addEventListener("keydown", onEscape);
    for (const tab of ACTIVITY_TABS) {
      deps.panels[tab].addEventListener("keydown", onEscape);
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

  close(): void {
    const next = reduceActivityTab(this.state, { type: "close" });
    if (next === this.state) return;
    this.state = next;
    this.apply();
    this.buttons.get(this.state.active)?.focus();
  }

  /** Badge + content state, never a request to open or switch a tool. */
  setContent(tab: ActivityTab, has: boolean, count: number): void {
    const next = reduceActivityTab(this.state, { type: "content", tab, has });
    this.writeCount(tab, count);
    if (next === this.state) return;
    this.state = next;
    this.apply();
  }

  /** Arrow/Home/End move along the visible tabs (WAI-ARIA tabs pattern). */
  private onKeydown(event: KeyboardEvent): void {
    const from = this.tabOf(event.target);
    if (!from) return;
    const tabs = visibleActivityTabs(this.state);
    // A just-hidden tab can still hold focus until apply() moves it. Start
    // from a reachable tab so arrows cannot get stuck on a stop that left.
    const origin = tabs.includes(from) ? from : tabs.includes(this.state.active) ? this.state.active : tabs[0];
    if (!origin) return;
    let next: ActivityTab | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      next = stepActivityTab(tabs, origin, event.key === "ArrowRight" ? 1 : -1);
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
    this.deps.closeButton.hidden = !this.state.open;
    for (const tab of ACTIVITY_TABS) {
      const shown = this.state.open && this.state.active === tab && this.state.visible[tab];
      const panel = this.deps.panels[tab];
      panel?.classList.toggle("tab-active", shown);
      const button = this.buttons.get(tab);
      button?.classList.toggle("active", shown);
      if (button) {
        button.hidden = !this.state.visible[tab];
        // Roving tabindex: Tab enters the bar at the selected tab, arrows move.
        button.tabIndex = this.state.active === tab ? 0 : -1;
        button.setAttribute("aria-selected", shown ? "true" : "false");
        button.setAttribute("aria-expanded", shown ? "true" : "false");
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
    // Hiding the focused tab (Modified off, Worldlines gone) must not leave
    // the key on a `hidden` button — arrows would then walk a dead stop.
    const focused = this.tabOf(document.activeElement);
    if (focused && !this.state.visible[focused]) {
      this.buttons.get(this.state.active)?.focus();
    }
  }
}
