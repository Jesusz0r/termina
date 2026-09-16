import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ACTIVITY_TAB_LABELS,
  ACTIVITY_TABS,
  activityEmptyVisible,
  activityPanelTitleVisible,
  initialActivityTabState,
  reduceActivityTab,
  resolveActivityTab,
  stepActivityTab,
  visibleActivityTabs,
} from "../../../src/activity-tabs.ts";

const html = readFileSync(new URL("../../../src/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../../src/styles.css", import.meta.url), "utf8");
const tabsSrc = readFileSync(new URL("../../../src/activity-tabs.ts", import.meta.url), "utf8");

function buttonMarkup(id: string): string {
  const match = html.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>[\\s\\S]*?</button>`));
  if (!match) throw new Error(`missing button #${id}`);
  return match[0];
}

function accessibleName(markup: string): string {
  const aria = /aria-label="([^"]*)"/.exec(markup)?.[1];
  if (aria) return aria;
  const text = markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (/[A-Za-z]{3,}/.test(text)) return text;
  return /title="([^"]*)"/.exec(markup)?.[1] ?? text;
}

function hasWordBeyondGlyph(name: string): boolean {
  return /[A-Za-z]{3,}/.test(name);
}

describe("activity tabs", () => {
  it("falls back to timeline for unknown stored values", () => {
    expect(resolveActivityTab("plan")).toBe("plan");
    expect(resolveActivityTab("worldlines")).toBe("worldlines");
    expect(resolveActivityTab(null)).toBe("timeline");
    expect(resolveActivityTab("nope")).toBe("timeline");
    expect(resolveActivityTab(undefined)).toBe("timeline");
  });

  it("manual select switches and persists the tab", () => {
    const s0 = initialActivityTabState("timeline");
    const s1 = reduceActivityTab(s0, { type: "select", tab: "plan" });
    expect(s1.active).toBe("plan");
    // Re-selecting the active tab is a no-op (same state identity).
    expect(reduceActivityTab(s1, { type: "select", tab: "plan" })).toBe(s1);
  });

  it("new plan/worldlines/modified content auto-switches once", () => {
    const s0 = initialActivityTabState("timeline");
    const s1 = reduceActivityTab(s0, { type: "content", tab: "plan", has: true });
    expect(s1.active).toBe("plan");
    // Already true: no new edge, state identity preserved.
    expect(reduceActivityTab(s1, { type: "content", tab: "plan", has: true })).toBe(s1);
  });

  it("an explicit tab pick holds the panel against content auto-switch", () => {
    // #63: the user returns to Timeline, and a run that adds Modified files
    // must not steal the panel. Picking the active tab still arms the hold.
    const s0 = reduceActivityTab(initialActivityTabState("timeline"), { type: "select", tab: "timeline" });
    expect(s0.held).toBe("timeline");
    const s1 = reduceActivityTab(s0, { type: "content", tab: "modified", has: true });
    expect(s1.active).toBe("timeline");
    // The arrival is not swallowed: the badge and the panel content still update.
    expect(s1.content.modified).toBe(true);
    // The hold moves with the user's next pick instead of expiring on its own.
    const s2 = reduceActivityTab(s1, { type: "select", tab: "plan" });
    const s3 = reduceActivityTab(s2, { type: "content", tab: "worldlines", has: true });
    expect(s3.active).toBe("plan");
    expect(reduceActivityTab(s3, { type: "select", tab: "plan" })).toBe(s3);
  });

  it("hiding the held tab releases the hold", () => {
    const s0 = reduceActivityTab(initialActivityTabState("timeline"), { type: "select", tab: "modified" });
    expect(s0.held).toBe("modified");
    // A project with no Modified surface cannot keep the auto-switch muted.
    const s1 = reduceActivityTab(s0, { type: "visibility", tab: "modified", visible: false });
    expect(s1.active).toBe("timeline");
    expect(s1.held).toBeNull();
    expect(reduceActivityTab(s1, { type: "content", tab: "worldlines", has: true }).active).toBe("worldlines");
  });

  it("timeline content never auto-switches", () => {
    const s0 = initialActivityTabState("plan");
    const s1 = reduceActivityTab(s0, { type: "content", tab: "timeline", has: true });
    expect(s1.active).toBe("plan");
  });

  it("content loss never switches away", () => {
    const s0 = reduceActivityTab(initialActivityTabState("timeline"), { type: "content", tab: "plan", has: true });
    const s1 = reduceActivityTab(s0, { type: "content", tab: "plan", has: false });
    expect(s1.active).toBe("plan");
    expect(s1.content.plan).toBe(false);
  });

  it("sync updates state without switching", () => {
    const s0 = initialActivityTabState("timeline");
    const s1 = reduceActivityTab(s0, { type: "sync", tab: "modified", has: true });
    expect(s1.active).toBe("timeline");
    expect(s1.content.modified).toBe(true);
  });

  it("hiding the active tab falls back to timeline", () => {
    const s0 = reduceActivityTab(initialActivityTabState("timeline"), { type: "select", tab: "modified" });
    const s1 = reduceActivityTab(s0, { type: "visibility", tab: "modified", visible: false });
    expect(s1.active).toBe("timeline");
    // Hidden tabs cannot be selected.
    expect(reduceActivityTab(s1, { type: "select", tab: "modified" })).toBe(s1);
  });

  it("arrow navigation walks only the visible tabs and wraps", () => {
    const hidden = reduceActivityTab(initialActivityTabState("timeline"), { type: "visibility", tab: "plan", visible: false });
    expect(visibleActivityTabs(hidden)).toEqual(["timeline", "worldlines", "modified"]);
    // The hidden tab is skipped in both directions.
    expect(stepActivityTab(visibleActivityTabs(hidden), "timeline", 1)).toBe("worldlines");
    expect(stepActivityTab(visibleActivityTabs(hidden), "worldlines", -1)).toBe("timeline");
    const noWorldlines = reduceActivityTab(initialActivityTabState("timeline"), { type: "visibility", tab: "worldlines", visible: false });
    expect(visibleActivityTabs(noWorldlines)).toEqual(["timeline", "plan", "modified"]);
    expect(stepActivityTab(visibleActivityTabs(noWorldlines), "plan", 1)).toBe("modified");
    expect(stepActivityTab(visibleActivityTabs(noWorldlines), "modified", -1)).toBe("plan");
    // Wrapping keeps every visible tab reachable by arrows alone.
    expect(stepActivityTab(ACTIVITY_TABS, "modified", 1)).toBe("timeline");
    expect(stepActivityTab(ACTIVITY_TABS, "timeline", -1)).toBe("modified");
    // Unreachable cases stay put instead of throwing.
    expect(stepActivityTab(["timeline"], "timeline", 1)).toBe("timeline");
    expect(stepActivityTab(ACTIVITY_TABS, "nope" as never, 1)).toBe("nope");
  });

  it("empty copy shows only on the selected tab with no content", () => {
    const s0 = initialActivityTabState("timeline");
    expect(activityEmptyVisible(s0, "timeline")).toBe(true);
    expect(activityEmptyVisible(s0, "plan")).toBe(false);
    expect(activityEmptyVisible(s0, "worldlines")).toBe(false);
    expect(activityEmptyVisible(s0, "modified")).toBe(false);

    const s1 = reduceActivityTab(s0, { type: "select", tab: "plan" });
    expect(activityEmptyVisible(s1, "timeline")).toBe(false);
    expect(activityEmptyVisible(s1, "plan")).toBe(true);

    const s2 = reduceActivityTab(s1, { type: "sync", tab: "plan", has: true });
    expect(activityEmptyVisible(s2, "plan")).toBe(false);

    // Terminal switch: this tab's content is gone, so the copy returns.
    const s3 = reduceActivityTab(s2, { type: "sync", tab: "plan", has: false });
    expect(activityEmptyVisible(s3, "plan")).toBe(true);

    // Another tab filling does not hide this tab's copy.
    const s4 = reduceActivityTab(s3, { type: "sync", tab: "modified", has: true });
    expect(activityEmptyVisible(s4, "plan")).toBe(true);
    expect(activityEmptyVisible(s4, "modified")).toBe(false);
  });

  it("repeats the tab name in panel chrome only when the tab bar is gone", () => {
    expect(activityPanelTitleVisible(true)).toBe(false);
    expect(activityPanelTitleVisible(false)).toBe(true);
    expect(tabsSrc).toContain('panel.toggleAttribute("data-repeat-title"');
    expect(tabsSrc).toContain('panel.setAttribute("aria-labelledby"');
    expect(css).toMatch(/#timeline-strip:not\(\[data-repeat-title\]\) \.activity-panel-title/);
    expect(css).toMatch(/#plan-panel:not\(\[data-repeat-title\]\) \.activity-panel-title/);
    expect(css).toMatch(/#worldline-panel:not\(\[data-repeat-title\]\) \.activity-panel-title/);
    expect(css).toMatch(/#modified-panel:not\(\[data-repeat-title\]\) \.activity-panel-title/);
    expect(css).toMatch(/\.activity-panel-title\s*\{[\s\S]*?display:\s*none/);
  });

  it("uses one spacing contract for activity panel chrome", () => {
    expect(css).toMatch(/\.timeline-header\s*,\s*\.panel-header\s*\{[^}]*padding:\s*6px 10px/);
    expect(css).toMatch(
      /\.activity-empty\s*,\s*#timeline-dots\s*,\s*#plan-list\s*,\s*#worldline-list\s*,\s*#modified-list\s*\{[^}]*padding:\s*6px 10px 10px/,
    );
    expect(css).not.toContain("#timeline-strip > .activity-empty");
    expect(css).not.toMatch(/#timeline-strip \{[^}]*padding:/);
  });

  it("keeps the tablist as the single visible title for each panel", () => {
    const tabbar = html.match(/id="activity-tabbar"[\s\S]*?<\/div>/)?.[0];
    expect(tabbar).toBeTruthy();
    for (const tab of ACTIVITY_TABS) {
      const label = ACTIVITY_TAB_LABELS[tab];
      expect(tabbar).toContain(`data-tab="${tab}"`);
      expect(tabbar).toContain(label);
      const titles = [...html.matchAll(/class="activity-panel-title">([^<]*)<\/span>/g)].map((m) => m[1]);
      expect(titles.some((title) => title === label || title.startsWith(label))).toBe(true);
    }
    // Title lives in the marked span (hidden while the tab bar is up), not as a second heading.
    expect(html).not.toMatch(/class="timeline-label">Timeline/);
    expect(html).not.toMatch(/<span>Plan<\/span>/);
    expect(html).not.toMatch(/<span>Worldlines<\/span>/);
    expect(html).not.toMatch(/<span>Modified files<\/span>/);
  });

  it("names glyph actions with visible text or an accessible word", () => {
    const actions = [
      { id: "btn-dispatch", visible: "Dispatch" },
      { id: "btn-timeline-play", visible: "Replay" },
      { id: "explorer-content-rerun", visible: "Re-run" },
      { id: "btn-fork-run", visible: "Fork Run" },
      { id: "btn-min-explorer", visible: "Minimize" },
      { id: "btn-min-terminal", visible: "Minimize" },
      { id: "btn-min-editor", visible: "Minimize" },
      { id: "btn-app-update", visible: "Update" },
    ];
    for (const action of actions) {
      const markup = buttonMarkup(action.id);
      const name = accessibleName(markup);
      expect(hasWordBeyondGlyph(name), `${action.id} accessible name: ${name}`).toBe(true);
      expect(name).toContain(action.visible);
    }
    expect(html).toMatch(/id="btn-dispatch"[^>]*>[\s\S]*<span class="action-label">Dispatch<\/span>/);
    expect(html).toMatch(/id="explorer-content-rerun"[^>]*>[\s\S]*<span class="action-label">Re-run<\/span>/);
    expect(css).toMatch(/#btn-timeline-play::after\s*\{[^}]*content:\s*"Replay"/);
    expect(css).toMatch(/#btn-timeline-play\s*\{[^}]*font-size:\s*0/);
    expect(css).toMatch(/@container activity-chrome \(max-width:/);
    expect(css).toMatch(/@container explorer-content \(max-width:/);
  });

  it("draws pane collapse as a chevron instead of a minus", () => {
    expect(css).toContain(".pane-toggle::before");
    expect(css).toMatch(/\.pane-toggle::before\s*\{[^}]*transform:\s*rotate\(135deg\)/);
    expect(css).toContain("PANE_MIN_ICON");
    expect(css).toMatch(/\.pane-toggle\s*\{[^}]*font-size:\s*0/);
  });
});
