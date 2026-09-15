import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { EvidenceSummary, WorldlineSummary } from "../../../shared/types";
import { TimelineView } from "../../../src/timeline.ts";
import { installFakeDom, type FakeDocument, type FakeEl } from "./fake-dom.ts";

type Worldlines = typeof import("../../../src/worldlines.ts");

const activityPane = readFileSync(new URL("../../../src/main/activity-pane.ts", import.meta.url), "utf8");
const terminalMenu = readFileSync(new URL("../../../src/main/terminal-menu.ts", import.meta.url), "utf8");
const worldlinesSrc = readFileSync(new URL("../../../src/worldlines.ts", import.meta.url), "utf8");
const modalsSrc = readFileSync(new URL("../../../src/components/modals.ts", import.meta.url), "utf8");
const timelineSrc = readFileSync(new URL("../../../src/timeline.ts", import.meta.url), "utf8");
const renderer = readFileSync(new URL("../../../src/main.ts", import.meta.url), "utf8");
const terminalFind = readFileSync(new URL("../../../src/main/terminal-find.ts", import.meta.url), "utf8");

describe("renderer core hardening batch, items 2-10 (refs #217)", () => {
  it("allowlists IPC-shaped class names (item 2)", () => {
    expect(activityPane).toContain('`plan-task state-${state}`');
    expect(activityPane).toContain("asKnownState(task.state, KNOWN_PLAN_STATES)");
    expect(activityPane).toContain('badge.className = `status-badge ${status}`');
    expect(worldlinesSrc).toContain('chip.className = `verdict verdict-${winner}`');
    expect(worldlinesSrc).toContain('line.className = `evidence-line evidence-${status}`');
    expect(worldlinesSrc).toContain("asKnownState(s.state, KNOWN_CANDIDATE_STATES)");
    expect(worldlinesSrc).not.toContain("KNOWN_CANDIDATE_STATES.has(s.state) ? s.state : \"creating\"");
    expect(modalsSrc).toContain('badge.className = `status-badge ${safe}`');
    expect(renderer).toContain('verifyBadge.className = `verify-badge state-${badgeState}`');
    expect(timelineSrc).toContain("this.recorderEl.className = `timeline-recorder rec-${safe}`");
    // No raw interpolations remain at these sites.
    expect(activityPane).not.toContain("`plan-task state-${task.state}`");
    expect(activityPane).not.toContain("`status-badge ${f.status}`");
    expect(worldlinesSrc).not.toContain("`verdict verdict-${v.winner}`");
    expect(worldlinesSrc).not.toContain("`evidence-line evidence-${rec.status}`");
    expect(worldlinesSrc).not.toContain("`cand-state state-${s.state}`");
    expect(worldlinesSrc).not.toContain("`status-badge ${f.status}`");
    expect(modalsSrc).not.toContain("`status-badge ${status}`");
    expect(renderer).not.toContain("`verify-badge state-${v.state}`");
  });

  it("retries the shell list after failure instead of caching [] (item 3)", () => {
    expect(terminalMenu).toContain("shellsPromise = null;");
    expect(terminalMenu).toContain("retries on the next open instead of caching [] forever");
    expect(terminalMenu).not.toContain("getShells().catch(() => [])");
  });

  it("documents pending activation as last-wins (item 4)", () => {
    expect(renderer).toContain("Deliberately last-wins");
    expect(renderer).toContain("let pendingActivateId: string | null = null;");
  });

  it("releases a hung large-change fetch via epoch, not a wall-clock timeout (item 5 / #277)", () => {
    expect(renderer).not.toContain("LARGE_CHANGE_FETCH_TIMEOUT_MS");
    expect(renderer).toContain("const largeChangeEpoch = new Map<string, number>();");
    expect(renderer).toContain("if (largeChangeEpoch.get(key) !== epoch) return;");
    expect(renderer).toContain('toast(`could not refresh ${pathBasename(path)}: ${(err as Error).message}`, "warning")');
  });

  it("repositions the find bar on container resize (item 6)", () => {
    expect(terminalFind).toContain("new ResizeObserver(() => {");
    expect(terminalFind).toContain("if (findBar && !findBar.hidden) positionTerminalFindBar();");
    expect(terminalFind).toContain("resizeObserver.observe(termContainer);");
  });

  it("notes the execCommand deprecation with its replacement limits (item 7)", () => {
    expect(renderer).toContain("document.execCommand is deprecated but has no replacement");
    expect(renderer).toContain("navigator.clipboard only");
  });

  it("drops the terminal badge on the null transition too (item 8)", () => {
    expect(worldlinesSrc).toContain("if (prev.terminalId && summary.terminalId !== prev.terminalId) {");
    expect(worldlinesSrc).not.toContain("if (summary.terminalId && prev.terminalId && summary.terminalId !== prev.terminalId) {");
  });

  it("routes nested projects by longest prefix (item 9)", () => {
    expect(renderer).toContain("let best: { projId: string; view: ProjectView } | null = null;");
    expect(renderer).toContain("if (!best || projView.cwd.length > best.view.cwd.length) best = { projId, view: projView };");
  });

  it("defers or queues boot pushes until the editor chunk resolves (item 10)", () => {
    expect(renderer).toContain("void ensureEditorModule().then(() => applyFolderOpened(e)).catch(() => undefined);");
    expect(renderer).toContain("function applyFolderOpened(e: FolderOpenedPayload): void {");
    expect(renderer).toContain("if (activeProjectId !== p.projectId || !editorModule) {");
    // Every openFileSmart caller floats it: the wrapper never rejects.
    expect(renderer).toContain("await openFileSmartInner(path, preview, requestedOwner, line, column);");
  });
});

describe("hardening behavior (refs #217)", () => {
  let worldlines: Worldlines;
  let fake: { document: FakeDocument; modalRoot: FakeEl; cleanup: () => void };

  function summary(label: "A" | "B", overrides: Partial<WorldlineSummary> = {}): WorldlineSummary {
    return {
      id: `cmp-1-${label.toLowerCase()}`,
      comparisonId: "cmp-1",
      label,
      role: label === "A" ? "reference" : "alternative",
      comparisonBaseStateId: "base",
      promotionBaseStateId: "base",
      headStateId: "head",
      sourceRunId: "run-1",
      terminalId: null,
      version: 1,
      state: "ready",
      error: null,
      root: `/r/${label.toLowerCase()}`,
      sessionFile: "session.jsonl",
      model: null,
      thinkingLevel: null,
      createdAt: Date.now(),
      ...overrides,
    };
  }

  function makePanel(): FakeEl {
    const panel = fake.document.createElement("div");
    for (const id of ["worldline-list", "worldline-count", "worldline-summary"]) {
      const el = fake.document.createElement("div");
      el.id = id;
      panel.appendChild(el);
    }
    const header = fake.document.createElement("div");
    header.className = "panel-header";
    panel.appendChild(header);
    return panel;
  }

  beforeAll(async () => {
    fake = installFakeDom();
    worldlines = await import("../../../src/worldlines.ts");
  });

  afterAll(() => {
    fake.cleanup();
  });

  it("forgets a candidate terminal badge when it closes without replacement", () => {
    const view = new worldlines.WorldlinesView(makePanel() as unknown as HTMLElement);
    view.bind({});
    view.upsert(summary("A", { terminalId: "term-9", version: 1 }));
    view.upsert(summary("B", { version: 1 }));
    expect(view.labelOfTerminal("term-9")).toBe("A");
    view.upsert(summary("A", { terminalId: null, version: 2 }));
    expect(view.labelOfTerminal("term-9")).toBeNull();
  });

  it("falls back hostile verdict, evidence, and candidate states to valid classes", () => {
    const panel = makePanel();
    const view = new worldlines.WorldlinesView(panel as unknown as HTMLElement);
    view.bind({});
    view.upsert(summary("A", { state: "evil-state" as WorldlineSummary["state"] }));
    view.upsert(summary("B"));
    const evidence: EvidenceSummary = {
      comparisonId: "cmp-1",
      ts: Date.now(),
      byCandidate: {
        A: [{ kind: "verify", stateId: "s", baseStateId: "b", status: "evil\" onload=\"x" as "pass", result: {}, reason: null }],
        B: [],
      },
      profiles: [{ profile: "preserve-api", winner: "evil\" onload=\"x" as "A", reason: "", eligibility: {} }],
      error: null,
    };
    view.upsertEvidence(evidence);
    expect(panel.querySelector(".cand-state")!.className).toBe("cand-state state-unknown");
    expect(panel.querySelector(".cand-state")!.textContent).toBe("unknown");
    expect(panel.querySelector(".verdict")!.className).toBe("verdict verdict-unknown");
    expect(panel.querySelector(".verdict")!.textContent).toBe("unknown");
    expect(panel.querySelector(".evidence-line")!.className).toBe("evidence-line evidence-unknown");
  });

  it("renders an unknown recorder state as unknown, not paused", () => {
    const container = fake.document.createElement("div");
    for (const id of ["timeline-dots", "timeline-count", "timeline-prefix", "timeline-recorder", "btn-timeline-play"]) {
      const el = fake.document.createElement("div");
      el.id = id;
      container.appendChild(el);
    }
    const view = new TimelineView(container as unknown as HTMLElement);
    view.setRecorder("evil-state" as "ready");
    const recorder = container.querySelector("#timeline-recorder")!;
    expect(recorder.className).toBe("timeline-recorder rec-unknown");
    expect(recorder.textContent).toBe("unknown");
  });
});
