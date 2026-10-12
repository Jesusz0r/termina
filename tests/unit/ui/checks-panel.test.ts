import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChecksPanel } from "../../../src/main/checks-panel.ts";
import { installFakeDom } from "./fake-dom.ts";

let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createChecksPanel>;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { view?.dispose(); dom.cleanup(); });
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
function harness() {
  const element = dom.document.createElement("section");
  for (const [tag, className] of [["p", "checks-context"], ["button", "checks-details"], ["pre", "checks-report"]]) {
    const node = dom.document.createElement(tag!); node.className = className!; element.append(node);
  }
  let context: ReturnType<Parameters<typeof createChecksPanel>[0]["getContext"]> = {
    target: { projectId: "proj-1", workspaceId: "ws-1", root: "/projects/proj-1", terminalId: "term-1", generation: 3 },
    activationGeneration: 1, verify: { state: "untested", command: null, summary: null },
  };
  const getVerifyReport = vi.fn(async (): Promise<string | null> => "**Status:** NOT RUN");
  view = createChecksPanel({ element: element as unknown as HTMLElement, getVerifyReport, getContext: () => context });
  view.syncContext();
  return { element, getVerifyReport, report: element.querySelector("pre")!, button: element.querySelector("button")!,
    context: element.querySelector("p")!, getContext: () => context,
    setContext: (next: typeof context, sync = true) => { context = next; if (sync) view.syncContext(); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe("contextual Checks", () => {
  it("is lazy, exact-generation and read-only, and preserves unrelated refreshes", async () => {
    const h = harness();
    expect(h.getVerifyReport).not.toHaveBeenCalled();
    expect(h.report.hidden).toBe(true);
    expect(h.context.textContent).toContain("term-1 · /projects/proj-1");
    h.button.click(); await flush();
    expect(h.getVerifyReport).toHaveBeenCalledExactlyOnceWith("term-1", 3);
    expect(h.report.textContent).toBe("**Status:** NOT RUN");
    view.syncContext(); expect(h.report.hidden).toBe(false);
  });
  it("invalidates green on source change and labels historical execution accurately", async () => {
    const h = harness(); await view.showCheck();
    h.setContext({ ...h.getContext()!, verify: { state: "stale", command: "npm run test", summary: "outdated", staleReason: "Source changed",
      result: { state: "pass", exitCode: 0, startedAt: 1, finishedAt: 2 } } });
    expect(h.report.hidden).toBe(true);
    expect(h.context.textContent).toContain("Outdated · npm run test · historical pass (exit 0)");
    expect(h.context.textContent).toContain("Source changed");
  });
  it.each(["project", "workspace", "generation", "activation"])("fences a delayed report after %s changes", async (change) => {
    const h = harness(); const old = deferred<string | null>(); h.getVerifyReport.mockReturnValueOnce(old.promise);
    const pending = view.showCheck(); const context = h.getContext()!;
    const target = { ...context.target };
    if (change === "project") target.projectId = "proj-2";
    if (change === "workspace") { target.workspaceId = "ws-2"; target.root = "/candidate"; }
    if (change === "generation") target.generation++;
    h.setContext({ ...context, target, activationGeneration: change === "activation" ? 2 : 1 });
    old.resolve("OLD GREEN"); expect(await pending).toBe(false);
    expect(h.report.hidden).toBe(true); expect(h.report.textContent).not.toBe("OLD GREEN");
  });
  it("also fences a changed context before the next render", async () => {
    const h = harness(); const old = deferred<string | null>(); h.getVerifyReport.mockReturnValueOnce(old.promise);
    const pending = view.showCheck(); h.setContext(null, false); old.resolve("OLD GREEN");
    expect(await pending).toBe(false); expect(h.report.textContent).not.toBe("OLD GREEN");
  });
  it("clears unavailable or shell context and never substitutes another terminal", async () => {
    const h = harness(); await view.showCheck(); h.setContext(null);
    expect(h.report.hidden).toBe(true); expect(h.button.disabled).toBe(true);
    expect(h.context.textContent).toContain("unavailable for shells");
    expect(await view.showCheck()).toBe(false); expect(h.getVerifyReport).toHaveBeenCalledOnce();
  });
  it("shows unavailable and rejected reports, not an empty success", async () => {
    const h = harness(); h.getVerifyReport.mockResolvedValueOnce(null);
    expect(await view.showCheck()).toBe(false); expect(h.report.textContent).toContain("unavailable");
    h.getVerifyReport.mockRejectedValueOnce(new Error("IPC failed"));
    expect(await view.showCheck()).toBe(false); expect(h.report.textContent).toContain("Could not load");
    expect(h.report.getAttribute("aria-busy")).toBe("false");
  });
  it("disposes listeners and rejects a late report", async () => {
    const h = harness(); const old = deferred<string | null>(); h.getVerifyReport.mockReturnValueOnce(old.promise);
    const pending = view.showCheck(); view.dispose(); old.resolve("OLD GREEN"); expect(await pending).toBe(false);
    h.button.click(); expect(h.getVerifyReport).toHaveBeenCalledOnce(); expect(h.report.hidden).toBe(true);
  });
});
