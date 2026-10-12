import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalMenu } from "../../../src/main/terminal-menu.ts";
import { installFakeDom } from "./fake-dom.ts";

let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createTerminalMenu>;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { view?.dispose(); vi.unstubAllGlobals(); dom.cleanup(); });

function harness() {
  const agent = dom.document.createElement("button");
  const anchor = dom.document.createElement("button");
  Object.assign(anchor, { getBoundingClientRect: () => ({ left: 100, bottom: 34 }) });
  dom.document.body.append(agent, anchor);
  const getShells = vi.fn().mockResolvedValue([{ name: "zsh", path: "/bin/zsh" }, { name: "bash", path: "/bin/bash" }]);
  const events = new EventTarget();
  vi.stubGlobal("window", Object.assign(events, { innerWidth: 1000, innerHeight: 720, termina: { getShells } }));
  const onCreateAgent = vi.fn<() => Promise<{ ok: boolean; error?: string }>>().mockResolvedValue({ ok: true });
  const onOpenShell = vi.fn<(path: string) => Promise<{ ok: boolean; error?: string }>>().mockResolvedValue({ ok: true });
  const onOpenCodex = vi.fn<() => Promise<{ ok: boolean; error?: string }>>().mockResolvedValue({ ok: true });
  const onError = vi.fn();
  view = createTerminalMenu({ agentButton: agent as unknown as HTMLButtonElement, anchor: anchor as unknown as HTMLButtonElement,
    onCreateAgent, onOpenShell, onOpenCodex, onError });
  const key = (value: string) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: value });
    events.dispatchEvent(event);
    return event;
  };
  const open = async () => { anchor.click(); await Promise.resolve(); await Promise.resolve(); };
  return { agent, anchor, getShells, onCreateAgent, onOpenShell, onOpenCodex, onError, events, key, open };
}

describe("direct agent creation and shell menu", () => {
  it("creates an agent in one action without listing shells or opening a menu", async () => {
    const h = harness(); h.agent.click(); await Promise.resolve();
    expect(h.onCreateAgent).toHaveBeenCalledOnce(); expect(h.onOpenShell).not.toHaveBeenCalled();
    expect(h.getShells).not.toHaveBeenCalled(); expect(view.isOpen()).toBe(false);
    await view.createAgent(); expect(h.onCreateAgent).toHaveBeenCalledTimes(2);
  });

  it("coalesces repeated click and command requests while creation is pending", async () => {
    const h = harness(); let resolve!: (value: { ok: boolean }) => void;
    h.onCreateAgent.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = view.createAgent(); h.agent.click(); await view.createAgent(); h.anchor.click();
    expect(h.onCreateAgent).toHaveBeenCalledOnce(); expect(h.getShells).not.toHaveBeenCalled();
    expect(h.agent.disabled).toBe(true); expect(h.anchor.disabled).toBe(true);
    expect(h.agent.getAttribute("aria-busy")).toBe("true");
    resolve({ ok: true }); await pending;
    expect(h.agent.disabled).toBe(false); expect(h.anchor.disabled).toBe(false);
    expect(h.agent.getAttribute("aria-busy")).toBe("false");
  });

  it("reports refusal and rejection and allows explicit retry without fallback", async () => {
    const h = harness(); h.onCreateAgent.mockResolvedValueOnce({ ok: false, error: "Independent area budget exhausted" });
    await view.createAgent(); expect(h.onError).toHaveBeenLastCalledWith("Independent area budget exhausted");
    h.onCreateAgent.mockRejectedValueOnce(new Error("Sandbox unavailable"));
    await view.createAgent(); expect(h.onError).toHaveBeenLastCalledWith("Sandbox unavailable");
    await view.createAgent(); expect(h.onCreateAgent).toHaveBeenCalledTimes(3);
    expect(h.onOpenShell).not.toHaveBeenCalled(); expect(h.agent.disabled).toBe(false);
  });

  it("opens Codex from the menu without treating it as a detected shell", async () => {
    const h = harness(); await h.open();
    (dom.document.body.querySelector(".terminal-menu-item") as HTMLElement).click();
    await Promise.resolve();
    expect(h.onOpenCodex).toHaveBeenCalledOnce();
    expect(h.onOpenShell).not.toHaveBeenCalled();
  });

  it("offers Codex and detected shells with native menu roles and keyboard selection", async () => {
    const h = harness(); await h.open();
    const menu = dom.document.body.querySelector("#terminal-shell-menu")!;
    const items = menu.querySelectorAll(".terminal-menu-item");
    expect(menu.getAttribute("role")).toBe("menu"); expect(items).toHaveLength(3);
    expect(items[0]!.querySelector(".terminal-menu-name")!.textContent).toBe("Codex");
    expect(items.every((item) => item.tagName === "BUTTON" && item.getAttribute("role") === "menuitem")).toBe(true);
    expect(dom.document.activeElement).toBe(items[0]); expect(h.anchor.getAttribute("aria-expanded")).toBe("true");
    h.key("End"); expect(dom.document.activeElement).toBe(items[2]);
    h.key("Home"); expect(dom.document.activeElement).toBe(items[0]);
    h.key("ArrowUp"); expect(dom.document.activeElement).toBe(items[2]);
    expect(h.key("Enter").defaultPrevented).toBe(true); await Promise.resolve();
    expect(h.onOpenShell).toHaveBeenCalledExactlyOnceWith("/bin/bash"); expect(h.onCreateAgent).not.toHaveBeenCalled();
    expect(view.isOpen()).toBe(false); expect(h.anchor.getAttribute("aria-expanded")).toBe("false");
    await h.open(); expect(h.getShells).toHaveBeenCalledOnce();
  });

  it("returns Escape focus to the opener but never steals outside focus", async () => {
    const h = harness(); await h.open(); h.key("Escape");
    expect(dom.document.activeElement).toBe(h.anchor); expect(h.onOpenShell).not.toHaveBeenCalled();
    await h.open(); h.agent.focus(); h.events.dispatchEvent(new Event("click"));
    expect(dom.document.activeElement).toBe(h.agent); expect(view.isOpen()).toBe(false);
  });

  it("cancels a pending shell listing on close, direct creation, or disposal", async () => {
    const h = harness(); let resolve!: (value: Array<{ name: string; path: string }>) => void;
    h.getShells.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    h.anchor.click(); view.close(); resolve([{ name: "zsh", path: "/bin/zsh" }]);
    await Promise.resolve(); await Promise.resolve(); expect(view.isOpen()).toBe(false);
    h.getShells.mockClear();
    await h.open(); expect(view.isOpen()).toBe(true);
    await view.createAgent(); expect(view.isOpen()).toBe(false);
    view.dispose(); h.agent.click(); h.anchor.click();
    expect(h.onCreateAgent).toHaveBeenCalledOnce(); expect(view.isOpen()).toBe(false);
  });

  it("retries failed or empty listings on the next open without creating anything", async () => {
    const h = harness(); h.getShells.mockRejectedValueOnce(new Error("listing unavailable"));
    await h.open();
    const emptyMenu = [...dom.document.body.querySelector("#terminal-shell-menu")!.children];
    expect(emptyMenu.some((child) => (child.textContent ?? "").includes("No shells available"))).toBe(true);
    view.close(); h.getShells.mockResolvedValueOnce([]); await h.open(); view.close(); await h.open();
    expect(h.getShells).toHaveBeenCalledTimes(3);
    expect(dom.document.body.querySelectorAll(".terminal-menu-item")).toHaveLength(3);
    expect(h.onCreateAgent).not.toHaveBeenCalled(); expect(h.onOpenShell).not.toHaveBeenCalled();
  });

  it("does not publish a menu or creation error after disposal", async () => {
    const h = harness(); let resolve!: (value: Array<{ name: string; path: string }>) => void;
    h.getShells.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    h.anchor.click(); view.dispose(); resolve([{ name: "zsh", path: "/bin/zsh" }]);
    await Promise.resolve(); await Promise.resolve(); expect(view.isOpen()).toBe(false);
  });
});
