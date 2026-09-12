/**
 * Terminal-type chooser: ＋ opens a menu (agent vs shells).
 * Owns the menu element, shell list cache, keyboard nav, and focus return.
 * Main wires the anchor button and pane callbacks; all menu state lives here.
 */

export interface TerminalMenuPane {
  instanceId: string;
  error: boolean;
  exited: boolean;
}

export interface TerminalMenuBindings {
  anchor: HTMLButtonElement;
  getActivePane(): TerminalMenuPane | undefined;
  hasPane(instanceId: string): boolean;
  getActiveProjectId(): string | null;
  activatePane(instanceId: string): void;
  createErrorPane(message: string): void;
  refocusActivePane(): void;
}

export function createTerminalMenu(bindings: TerminalMenuBindings): {
  isOpen(): boolean;
  open(): Promise<void>;
  close(): void;
  toggle(): void;
  dispose(): void;
} {
  let terminalMenu: HTMLElement | null = null;
  let terminalMenuCleanups: Array<() => void> = [];
  let shellsCache: { name: string; path: string }[] | null = null;
  let shellsPromise: Promise<{ name: string; path: string }[]> | null = null;

  async function getAvailableShells(): Promise<{ name: string; path: string }[]> {
    if (shellsCache) return shellsCache;
    if (!shellsPromise) {
      shellsPromise = window.termina.getShells().catch(() => []);
    }
    shellsCache = await shellsPromise;
    return shellsCache;
  }

  async function openTerminalMenu(): Promise<void> {
    if (terminalMenu) {
      closeTerminalMenu();
      return;
    }
    const shells = await getAvailableShells();
    if (terminalMenu) {
      closeTerminalMenu();
      return;
    }
    const menu = document.createElement("div");
    menu.className = "terminal-menu";
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
    };

    const makeTerminal = (opts?: { type?: "agent" | "shell"; shell?: string; engine?: "core" }) => {
      const source = bindings.getActivePane();
      const fromTerminalId = source && !source.error && !source.exited ? source.instanceId : undefined;
      const inherit = Boolean(fromTerminalId) && opts?.type !== "shell";
      const projectId = bindings.getActiveProjectId() ?? undefined;
      const withProject = projectId ? { ...opts, projectId } : opts;
      void window.termina.createTerminal(inherit ? { ...withProject, fromTerminalId } : withProject).then((res) => {
        if (!res.ok) {
          bindings.createErrorPane(res.error ?? "could not create terminal");
          return;
        }
        if (res.id && bindings.hasPane(res.id)) bindings.activatePane(res.id);
      });
    };

    const addItem = (label: string, desc: string, run: () => void) => {
      const row = document.createElement("div");
      row.className = "terminal-menu-item";
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

    addItem("Agent (core)", "Termina's in-house coding agent", () => makeTerminal({ type: "agent", engine: "core" }));
    for (const shell of shells) {
      addItem(shell.name, `interactive ${shell.name} shell`, () => makeTerminal({ type: "shell", shell: shell.path }));
    }

    updateSelection(0);

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
    menu.focus();
  }

  function closeTerminalMenu(): void {
    for (const cleanup of terminalMenuCleanups) cleanup();
    terminalMenuCleanups = [];
    const menu = terminalMenu;
    terminalMenu?.remove();
    terminalMenu = null;
    // Focus returns to the terminal only when a menu was open. Every window
    // click routes here; stealing focus on each one breaks editor typing.
    if (menu) bindings.refocusActivePane();
  }

  function isOpen(): boolean {
    return terminalMenu !== null;
  }

  function toggle(): void {
    if (terminalMenu) closeTerminalMenu();
    else void openTerminalMenu();
  }

  const onAnchorClick = (e: MouseEvent): void => {
    e.stopPropagation();
    toggle();
  };
  const onWindowClick = (): void => {
    closeTerminalMenu();
  };
  const onWindowBlur = (): void => {
    closeTerminalMenu();
  };
  bindings.anchor.addEventListener("click", onAnchorClick);
  window.addEventListener("click", onWindowClick);
  window.addEventListener("blur", onWindowBlur);

  function dispose(): void {
    bindings.anchor.removeEventListener("click", onAnchorClick);
    window.removeEventListener("click", onWindowClick);
    window.removeEventListener("blur", onWindowBlur);
    closeTerminalMenu();
  }

  return { isOpen, open: openTerminalMenu, close: closeTerminalMenu, toggle, dispose };
}
