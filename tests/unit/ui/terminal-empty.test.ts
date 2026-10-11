import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalEmpty } from "../../../src/main/terminal-empty.ts";
import { installFakeDom } from "./fake-dom.ts";

let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createTerminalEmpty>;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { view?.dispose(); dom.cleanup(); });
function harness() {
  const element = dom.document.createElement("section");
  element.hidden = true;
  const agent = dom.document.createElement("button"); agent.id = "btn-empty-create-agent";
  const shell = dom.document.createElement("button"); shell.id = "btn-empty-open-shell";
  const status = dom.document.createElement("p"); status.id = "terminal-empty-status";
  element.append(agent, shell, status); dom.document.body.append(element);
  const onCreateAgent = vi.fn(async () => ({ ok: true }));
  const onOpenShell = vi.fn(async () => ({ ok: true }));
  view = createTerminalEmpty({ element: element as unknown as HTMLElement, onCreateAgent, onOpenShell });
  return { element, agent, shell, status, onCreateAgent, onOpenShell };
}

describe("terminal empty state", () => {
  it("shows and hides without actions or moving focus", () => {
    const h = harness(); h.agent.focus();
    view.sync(true); expect(h.element.hidden).toBe(false);
    view.sync(false); expect(h.element.hidden).toBe(true);
    expect(dom.document.activeElement).toBe(h.agent);
    expect(h.onCreateAgent).not.toHaveBeenCalled(); expect(h.onOpenShell).not.toHaveBeenCalled();
    h.agent.click(); expect(h.onCreateAgent).not.toHaveBeenCalled();
  });
  it("calls only the explicit action", async () => {
    const h = harness(); view.sync(true);
    h.agent.click(); await Promise.resolve();
    expect(h.onCreateAgent).toHaveBeenCalledTimes(1); expect(h.onOpenShell).not.toHaveBeenCalled();
    h.shell.click(); await Promise.resolve();
    expect(h.onOpenShell).toHaveBeenCalledTimes(1);
    expect(h.status.textContent).toBe(""); expect(h.element.getAttribute("aria-busy")).toBe("false");
  });
  it("coalesces both buttons until the pending callback settles", async () => {
    const h = harness(); view.sync(true);
    let resolve!: (result: { ok: boolean }) => void;
    h.onCreateAgent.mockImplementation(() => new Promise((done) => { resolve = done; }));
    h.agent.click(); h.agent.click(); h.shell.click();
    expect(h.onCreateAgent).toHaveBeenCalledTimes(1); expect(h.onOpenShell).not.toHaveBeenCalled();
    expect(h.agent.disabled).toBe(true); expect(h.shell.disabled).toBe(true);
    expect(h.element.getAttribute("aria-busy")).toBe("true"); expect(h.status.textContent).toBe("Creating agent…");
    resolve({ ok: true }); await Promise.resolve();
    expect(h.agent.disabled).toBe(false); expect(h.shell.disabled).toBe(false);
  });
  it("shows refusal and rejection and permits retry", async () => {
    const h = harness(); view.sync(true);
    h.onOpenShell.mockResolvedValueOnce({ ok: false });
    h.shell.click(); await Promise.resolve();
    expect(h.status.textContent).toBe("Terminal was not created. Try again.");
    h.onOpenShell.mockRejectedValueOnce(new Error("Shell unavailable"));
    h.shell.click(); await Promise.resolve();
    expect(h.status.textContent).toBe("Shell unavailable"); expect(h.shell.disabled).toBe(false);
    h.shell.click(); await Promise.resolve();
    expect(h.onOpenShell).toHaveBeenCalledTimes(3); expect(h.status.textContent).toBe("");
  });
  it("removes listeners and ignores late callback results after dispose", async () => {
    const h = harness(); view.sync(true);
    h.agent.click(); view.dispose(); view.dispose(); await Promise.resolve();
    h.agent.click(); h.shell.click(); view.sync(false);
    expect(h.onCreateAgent).toHaveBeenCalledTimes(1); expect(h.onOpenShell).not.toHaveBeenCalled();
    expect(h.element.hidden).toBe(false); expect(h.status.textContent).toBe("Creating agent…");
  });
});
