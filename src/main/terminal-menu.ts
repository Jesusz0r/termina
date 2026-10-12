/** Direct agent creation and the secondary shell picker; main owns creation and selection. */
type CreateResult = { ok: boolean; error?: string };

interface TerminalMenuBindings {
  agentButton: HTMLButtonElement;
  anchor: HTMLButtonElement;
  onCreateAgent(): Promise<CreateResult>;
  onOpenShell(path: string): Promise<CreateResult>;
  onOpenCodex(): Promise<CreateResult>;
  onError(message: string): void;
}

export function createTerminalMenu(bindings: TerminalMenuBindings): {
  isOpen(): boolean;
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
    bindings.agentButton.disabled = bindings.anchor.disabled = true;
    bindings.agentButton.setAttribute("aria-busy", "true");
    try {
      const result = await action();
      if (!disposed && !result.ok) bindings.onError(result.error ?? "Could not create terminal. Try again.");
    } catch (error) {
      if (!disposed) bindings.onError(error instanceof Error ? error.message : "Could not create terminal. Try again.");
    } finally {
      pending = false;
      if (!disposed) {
        bindings.agentButton.disabled = bindings.anchor.disabled = false;
        bindings.agentButton.setAttribute("aria-busy", "false");
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

  async function openTerminalMenu(): Promise<void> {
    if (disposed || pending) return;
    if (terminalMenu || opening) {
      closeTerminalMenu();
      return;
    }
    const sequence = ++openSequence;
    opening = true;
    bindings.anchor.setAttribute("aria-expanded", "true");
    const shells = await getAvailableShells();
    if (disposed || sequence !== openSequence) return;
    opening = false;
    const menu = document.createElement("div");
    menu.id = "terminal-shell-menu";
    menu.className = "terminal-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Open shell");
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

    addItem("Codex", "original Codex TUI; trust its hook for activity", () => { void create(() => bindings.onOpenCodex()); });
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
    const rect = bindings.anchor.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(rect.left, window.innerWidth - 240 - pad));
    const top = Math.max(pad, Math.min(rect.bottom + 6, window.innerHeight - 100));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    terminalMenu = menu;
    if (items.length > 0) updateSelection(0);
    else menu.focus();
  }

  function closeTerminalMenu(restoreFocus = true): void {
    openSequence++;
    opening = false;
    bindings.anchor.setAttribute("aria-expanded", "false");
    for (const cleanup of terminalMenuCleanups) cleanup();
    terminalMenuCleanups = [];
    const menu = terminalMenu;
    const ownedFocus = menu?.contains(document.activeElement);
    terminalMenu?.remove();
    terminalMenu = null;
    // Outside clicks must not steal editor focus.
    if (restoreFocus && ownedFocus) bindings.anchor.focus();
  }

  function isOpen(): boolean {
    return terminalMenu !== null;
  }

  const onAgentClick = (): void => { void createAgent(); };
  const onAnchorClick = (e: MouseEvent): void => {
    e.stopPropagation();
    void openTerminalMenu();
  };
  const onWindowClick = (): void => {
    closeTerminalMenu();
  };
  const onWindowBlur = (): void => {
    closeTerminalMenu();
  };
  bindings.agentButton.addEventListener("click", onAgentClick);
  bindings.anchor.addEventListener("click", onAnchorClick);
  window.addEventListener("click", onWindowClick);
  window.addEventListener("blur", onWindowBlur);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    bindings.agentButton.removeEventListener("click", onAgentClick);
    bindings.anchor.removeEventListener("click", onAnchorClick);
    window.removeEventListener("click", onWindowClick);
    window.removeEventListener("blur", onWindowBlur);
    closeTerminalMenu(false);
  }

  return { isOpen, createAgent, close: closeTerminalMenu, dispose };
}
