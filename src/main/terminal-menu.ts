/** One new-terminal control. The button and Cmd/Ctrl+T open the chooser. */
import type { ExternalCli } from "../../shared/types";

type CreateResult = { ok: boolean; error?: string };

const EXTERNAL_MENU: Array<{ cli: ExternalCli; label: string; desc: string }> = [
  { cli: "codex", label: "Codex", desc: "original Codex TUI; trust its hook for activity" },
  { cli: "claude", label: "Claude", desc: "original Claude Code TUI; trust its hook for activity" },
  { cli: "grok", label: "Grok", desc: "original Grok TUI; its hook reports activity" },
  { cli: "gemini", label: "Gemini", desc: "Antigravity CLI (agy); its hook reports activity" },
  { cli: "muse", label: "Muse", desc: "original Muse Code TUI; its hook reports activity" },
];

interface TerminalMenuBindings {
  button: HTMLButtonElement;
  onCreateAgent(): Promise<CreateResult>;
  onOpenShell(path: string): Promise<CreateResult>;
  onOpenCli(cli: ExternalCli): Promise<CreateResult>;
  onError(message: string): void;
}

export function createTerminalMenu(bindings: TerminalMenuBindings): {
  isOpen(): boolean;
  open(): Promise<void>;
  createAgent(): Promise<void>;
  close(): void;
  dispose(): void;
} {
  let terminalMenu: HTMLElement | null = null;
  let terminalMenuCleanups: Array<() => void> = [];
  let shellsCache: { name: string; path: string }[] | null = null;
  let shellsPromise: Promise<{ name: string; path: string }[]> | null = null;
  let openSequence = 0;
  let opening = false;
  let pending = false;
  let disposed = false;

  async function create(action: () => Promise<CreateResult>): Promise<void> {
    if (disposed || pending) return;
    closeTerminalMenu(false);
    pending = true;
    bindings.button.disabled = true;
    bindings.button.setAttribute("aria-busy", "true");
    try {
      const result = await action();
      if (!disposed && !result.ok) bindings.onError(result.error ?? "Could not create terminal. Try again.");
    } catch (error) {
      if (!disposed) bindings.onError(error instanceof Error ? error.message : "Could not create terminal. Try again.");
    } finally {
      pending = false;
      if (!disposed) {
        bindings.button.disabled = false;
        bindings.button.setAttribute("aria-busy", "false");
      }
    }
  }

  function createAgent(): Promise<void> {
    return create(bindings.onCreateAgent);
  }

  async function getAvailableShells(): Promise<{ name: string; path: string }[]> {
    if (shellsCache) return shellsCache;
    if (!shellsPromise) {
      shellsPromise = window.termina.getShells();
    }
    try {
      shellsCache = await shellsPromise;
    } catch {
      // A failed listing retries on the next open instead of caching [] forever.
      shellsPromise = null;
      return [];
    }
    return shellsCache;
  }

  async function openTerminalMenu(toggle = false): Promise<void> {
    if (disposed || pending) return;
    if (terminalMenu || opening) {
      if (toggle) closeTerminalMenu();
      return;
    }
    const sequence = ++openSequence;
    opening = true;
    bindings.button.setAttribute("aria-expanded", "true");
    const shells = await getAvailableShells();
    if (disposed || sequence !== openSequence) return;
    opening = false;
    const menu = document.createElement("div");
    menu.id = "terminal-shell-menu";
    menu.className = "terminal-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "New terminal");
    menu.tabIndex = -1;
    menu.addEventListener("click", (e) => e.stopPropagation());

    const items: Array<{ row: HTMLElement; run: () => void }> = [];
    let selectedIndex = 0;

    const updateSelection = (index: number): void => {
      if (items.length === 0) return;
      selectedIndex = (index + items.length) % items.length;
      for (let i = 0; i < items.length; i++) {
        items[i].row.classList.toggle("selected", i === selectedIndex);
      }
      items[selectedIndex]?.row.scrollIntoView({ block: "nearest" });
      items[selectedIndex]?.row.focus();
    };

    const addItem = (label: string, desc: string, run: () => void) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "terminal-menu-item";
      row.setAttribute("role", "menuitem");
      row.tabIndex = -1;
      const name = document.createElement("span");
      name.className = "terminal-menu-name";
      name.textContent = label;
      const d = document.createElement("span");
      d.className = "terminal-menu-desc";
      d.textContent = desc;
      row.append(name, d);
      const itemIndex = items.length;
      row.addEventListener("mouseenter", () => updateSelection(itemIndex));
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTerminalMenu();
        run();
      });
      menu.appendChild(row);
      items.push({ row, run });
    };

    addItem("Agent", "Termina's in-house coding agent", () => { void createAgent(); });
    for (const item of EXTERNAL_MENU) {
      addItem(item.label, item.desc, () => { void create(() => bindings.onOpenCli(item.cli)); });
    }
    for (const shell of shells) {
      addItem(shell.name, `interactive ${shell.name} shell`, () => { void create(() => bindings.onOpenShell(shell.path)); });
    }
    if (shells.length === 0) {
      const message = document.createElement("p");
      message.textContent = "No shells available. Close and reopen to try again.";
      menu.appendChild(message);
      // An empty listing may be temporary; permit the next open to retry.
      shellsCache = null;
      shellsPromise = null;
    }

    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        updateSelection(selectedIndex + 1);
      } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        updateSelection(selectedIndex - 1);
      } else if (e.key === "Home") {
        e.preventDefault();
        e.stopPropagation();
        updateSelection(0);
      } else if (e.key === "End") {
        e.preventDefault();
        e.stopPropagation();
        updateSelection(items.length - 1);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        const chosen = items[selectedIndex];
        closeTerminalMenu();
        chosen?.run();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeTerminalMenu();
      }
    };

    window.addEventListener("keydown", onKeydown, true);
    terminalMenuCleanups.push(() => {
      window.removeEventListener("keydown", onKeydown, true);
    });

    document.body.appendChild(menu);
    const rect = bindings.button.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(rect.left, window.innerWidth - menu.offsetWidth - pad));
    const top = Math.max(pad, Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - pad));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    terminalMenu = menu;
    if (items.length > 0) updateSelection(0);
    else menu.focus();
  }

  function closeTerminalMenu(restoreFocus = true): void {
    openSequence++;
    opening = false;
    bindings.button.setAttribute("aria-expanded", "false");
    for (const cleanup of terminalMenuCleanups) cleanup();
    terminalMenuCleanups = [];
    const menu = terminalMenu;
    const ownedFocus = menu?.contains(document.activeElement);
    terminalMenu?.remove();
    terminalMenu = null;
    // Outside clicks must not steal editor focus.
    if (restoreFocus && ownedFocus) bindings.button.focus();
  }

  function isOpen(): boolean {
    return terminalMenu !== null;
  }

  const onButtonClick = (e: MouseEvent): void => {
    e.stopPropagation();
    void openTerminalMenu(true);
  };
  const onWindowClick = (): void => {
    closeTerminalMenu();
  };
  const onWindowBlur = (): void => {
    closeTerminalMenu();
  };
  bindings.button.addEventListener("click", onButtonClick);
  window.addEventListener("click", onWindowClick);
  window.addEventListener("blur", onWindowBlur);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    bindings.button.removeEventListener("click", onButtonClick);
    window.removeEventListener("click", onWindowClick);
    window.removeEventListener("blur", onWindowBlur);
    closeTerminalMenu(false);
  }

  return { isOpen, open: () => openTerminalMenu(false), createAgent, close: closeTerminalMenu, dispose };
}
