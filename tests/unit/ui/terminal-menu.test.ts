import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalMenu } from "../../../src/main/terminal-menu.ts";
import { installFakeDom } from "./fake-dom.ts";

let dom: ReturnType<typeof installFakeDom>;
let view: ReturnType<typeof createTerminalMenu>;
beforeEach(() => { dom = installFakeDom(); });
afterEach(() => { view?.dispose(); vi.unstubAllGlobals(); dom.cleanup(); });

function harness() {
  const button = dom.document.createElement("button");
  const outside = dom.document.createElement("button");
  Object.assign(button, { getBoundingClientRect: () => ({ left: 100, bottom: 34 }) });
  dom.document.body.append(button, outside);
  const getShells = vi.fn().mockResolvedValue([{ name: "zsh", path: "/bin/zsh" }, { name: "bash", path: "/bin/bash" }]);
  const events = new EventTarget();
  vi.stubGlobal("window", Object.assign(events, { innerWidth: 1000, innerHeight: 720, termina: { getShells } }));
  const onCreateAgent = vi.fn<() => Promise<{ ok: boolean; error?: string }>>().mockResolvedValue({ ok: true });
  const onOpenShell = vi.fn<(path: string) => Promise<{ ok: boolean; error?: string }>>().mockResolvedValue({ ok: true });
  const onOpenCli = vi.fn<(cli: string) => Promise<{ ok: boolean; error?: string }>>().mockResolvedValue({ ok: true });
  const onError = vi.fn();
  view = createTerminalMenu({ button: button as unknown as HTMLButtonElement, onCreateAgent, onOpenShell, onOpenCli, onError });
  const key = (value: string) => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: value });
    events.dispatchEvent(event);
    return event;
  };
  const open = async () => { button.click(); await Promise.resolve(); await Promise.resolve(); };
  return { button, outside, getShells, onCreateAgent, onOpenShell, onOpenCli, onError, events, key, open };
}

describe("terminal chooser", () => {
  it("opens the chooser from the command without creating a terminal", async () => {
    const h = harness();
    await view.open();
    expect(h.onCreateAgent).not.toHaveBeenCalled();
    expect(h.onOpenShell).not.toHaveBeenCalled();
    expect(h.onOpenCli).not.toHaveBeenCalled();
    expect(view.isOpen()).toBe(true);
    expect(dom.document.body.querySelector(".terminal-menu-name")!.textContent).toBe("Agent");
    await view.open();
    expect(view.isOpen()).toBe(true);
    h.button.click();
    expect(view.isOpen()).toBe(false);
  });

  it("coalesces repeated click and command requests while creation is pending", async () => {
    const h = harness(); let resolve!: (value: { ok: boolean }) => void;
    h.onCreateAgent.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = view.createAgent(); await view.open(); h.button.click(); await view.createAgent();
    expect(h.onCreateAgent).toHaveBeenCalledOnce(); expect(h.getShells).not.toHaveBeenCalled();
    expect(h.button.disabled).toBe(true);
    expect(h.button.getAttribute("aria-busy")).toBe("true");
    expect(view.isOpen()).toBe(false);
    resolve({ ok: true }); await pending;
    expect(h.button.disabled).toBe(false);
    expect(h.button.getAttribute("aria-busy")).toBe("false");
  });

  it("reports refusal and rejection and allows explicit retry without fallback", async () => {
    const h = harness(); h.onCreateAgent.mockResolvedValueOnce({ ok: false, error: "Independent area budget exhausted" });
    await view.createAgent(); expect(h.onError).toHaveBeenLastCalledWith("Independent area budget exhausted");
    h.onCreateAgent.mockRejectedValueOnce(new Error("Sandbox unavailable"));
    await view.createAgent(); expect(h.onError).toHaveBeenLastCalledWith("Sandbox unavailable");
    await view.createAgent(); expect(h.onCreateAgent).toHaveBeenCalledTimes(3);
    expect(h.onOpenShell).not.toHaveBeenCalled(); expect(h.button.disabled).toBe(false);
  });

  it("opens Codex from the menu without treating it as a detected shell", async () => {
    const h = harness(); await h.open();
    const codex = [...dom.document.body.querySelectorAll(".terminal-menu-name")].find((el) => el.textContent === "Codex");
    const row = codex?.parentElement;
    expect(row).toBeTruthy();
    row!.click();
    await Promise.resolve();
    expect(h.onOpenCli).toHaveBeenCalledExactlyOnceWith("codex");
    expect(h.onCreateAgent).not.toHaveBeenCalled();
    expect(h.onOpenShell).not.toHaveBeenCalled();
  });

  it("offers Codex and detected shells with native menu roles and keyboard selection", async () => {
    const h = harness(); await h.open();
    const menu = dom.document.body.querySelector("#terminal-shell-menu")!;
    const items = menu.querySelectorAll(".terminal-menu-item");
    expect(menu.getAttribute("role")).toBe("menu"); expect(items).toHaveLength(8);
    expect(items[0]!.querySelector(".terminal-menu-name")!.textContent).toBe("Agent");
    expect(items.every((item) => item.tagName === "BUTTON" && item.getAttribute("role") === "menuitem")).toBe(true);
    expect(dom.document.activeElement).toBe(items[0]); expect(h.button.getAttribute("aria-expanded")).toBe("true");
    h.key("End"); expect(dom.document.activeElement).toBe(items[7]);
    h.key("Home"); expect(dom.document.activeElement).toBe(items[0]);
    h.key("ArrowUp"); expect(dom.document.activeElement).toBe(items[7]);
    expect(h.key("Enter").defaultPrevented).toBe(true); await Promise.resolve();
    expect(h.onOpenShell).toHaveBeenCalledExactlyOnceWith("/bin/bash"); expect(h.onCreateAgent).not.toHaveBeenCalled();
    expect(view.isOpen()).toBe(false); expect(h.button.getAttribute("aria-expanded")).toBe("false");
    await h.open(); expect(h.getShells).toHaveBeenCalledOnce();
  });

  it("returns Escape focus to the opener but never steals outside focus", async () => {
    const h = harness(); await h.open(); h.key("Escape");
    expect(dom.document.activeElement).toBe(h.button); expect(h.onOpenShell).not.toHaveBeenCalled();
    await h.open(); h.outside.focus(); h.events.dispatchEvent(new Event("click"));
    expect(dom.document.activeElement).toBe(h.outside); expect(view.isOpen()).toBe(false);
  });

  it("cancels a pending shell listing on close, direct creation, or disposal", async () => {
    const h = harness(); let resolve!: (value: Array<{ name: string; path: string }>) => void;
    h.getShells.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    h.button.click(); view.close(); resolve([{ name: "zsh", path: "/bin/zsh" }]);
    await Promise.resolve(); await Promise.resolve(); expect(view.isOpen()).toBe(false);
    h.getShells.mockClear();
    await h.open(); expect(view.isOpen()).toBe(true);
    await view.createAgent(); expect(view.isOpen()).toBe(false);
    view.dispose(); h.button.click();
    expect(h.onCreateAgent).toHaveBeenCalledOnce(); expect(view.isOpen()).toBe(false);
  });

  it("retries failed or empty listings on the next open without creating anything", async () => {
    const h = harness(); h.getShells.mockRejectedValueOnce(new Error("listing unavailable"));
    await h.open();
    const emptyMenu = [...dom.document.body.querySelector("#terminal-shell-menu")!.children];
    expect(emptyMenu.some((child) => (child.textContent ?? "").includes("No shells available"))).toBe(true);
    view.close(); h.getShells.mockResolvedValueOnce([]); await h.open(); view.close(); await h.open();
    expect(h.getShells).toHaveBeenCalledTimes(3);
    expect(dom.document.body.querySelectorAll(".terminal-menu-item")).toHaveLength(8);
    expect(h.onCreateAgent).not.toHaveBeenCalled(); expect(h.onOpenShell).not.toHaveBeenCalled();
  });

  it("does not publish a menu or creation error after disposal", async () => {
    const h = harness(); let resolve!: (value: Array<{ name: string; path: string }>) => void;
    h.getShells.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    h.button.click(); view.dispose(); resolve([{ name: "zsh", path: "/bin/zsh" }]);
    await Promise.resolve(); await Promise.resolve(); expect(view.isOpen()).toBe(false);
  });
});
