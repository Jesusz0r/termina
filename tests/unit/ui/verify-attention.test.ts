import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Source-level probes for the unseen-failure tab nudge: a fail/timeout that
 * lands on a background pane dots its tab until first view, while newer
 * verify states and activation clear it. The Electron suite covers the
 * visible badge path; this probe covers the background-tab wiring without
 * a live display server.
 */
describe("Verify Attention Invariants", () => {
  it("dots background tabs on unseen failure and clears on view", async () => {
    const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
    const css = readFileSync(new URL("../../../src/styles.css", import.meta.url), "utf8");
    const checks: string[] = [];
    function check(name: string, value: unknown) {
      assert.equal(Boolean(value), true, name);
      checks.push(name);
    }

    // Attention is transient UI state defaulting to false.
    check("pane carries transient attention state",
      renderer.includes("verifyAttention: boolean;")
      && renderer.includes("verifyAttention: false,"));
    // Background-only nudge; newer states clear.
    check("fail/timeout nudges background panes, newer states clear",
      renderer.includes("if (verify.state === \"fail\" || verify.state === \"timeout\") {")
      && renderer.includes("pane.verifyAttention = activeId !== terminalId;"));
    // Tab dot follows state + attention; timeout gets its own color.
    check("tab dot reflects fail/timeout attention",
      renderer.includes("const failDot = pane.verifyAttention && pane.verify.state === \"fail\";")
      && renderer.includes("applyTabActivity(pane.statusEl, presented, { fail: failDot, timeout: timeoutDot })"));
    // Activation clears and repaint follows every update.
    check("activation clears the nudge",
      renderer.includes("if (pane.verifyAttention) {")
      && renderer.includes("pane.verifyAttention = false;"));
    check("verify pushes repaint the tab",
      renderer.includes("updatePaneTab(pane);")
      && renderer.includes("if (activeId === terminalId) renderStatus(pane);"));
    // Dots are solid (no busy blink) with theme colors.
    check("dot styles use theme colors without blink",
      /\.terminal-tab \.tab-status\.verify-fail \{[^}]*background: var\(--red\);[^}]*animation: none;/s.test(css)
      && /\.terminal-tab \.tab-status\.verify-timeout \{[^}]*background: var\(--yellow\);[^}]*animation: none;/s.test(css));
    check("terminal idle and working keep the tab-status language",
      css.includes(".terminal-tab .tab-status.idle {")
      && css.includes("background: var(--green);")
      && css.includes(".terminal-tab .tab-status.busy {")
      && css.includes("background: var(--accent);")
      && css.includes("animation: activity-pulse")
      && css.includes("@keyframes activity-pulse")
      && css.includes("transform: scale(1.55)"));
    // Project attention is factual, not a mirror of transient terminal nudges.
    const rail = readFileSync(new URL("../../../src/main/project-rail.ts", import.meta.url), "utf8");
    check("overview is wired directly to the canonical project rail",
      renderer.includes("onOverview: (overview) => projectRail.setOverview(overview)")
      && rail.includes("project.working")
      && rail.includes("project.attentionCount")
      && !rail.includes("verifyAttention")
      && !renderer.includes("updateProjectAttention")
      && !css.includes(".project-tab .tab-status"));
    assert.ok(checks.length >= 7);
  });
});
