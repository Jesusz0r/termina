/**
 * Terminal find bar: one overlay searching the active pane's scrollback.
 * Owns the bar DOM, live decorations, and the container ResizeObserver.
 * Main wires the command and pane lookup; search state stays in each
 * pane's SearchAddon so switching panes never leaves stale highlights.
 */

export interface TerminalFindView {
  clearFind(): void;
  findNext(term: string): boolean;
  findPrevious(term: string): boolean;
  onFindResults(cb: (index: number, count: number) => void): { dispose(): void } | null;
  focus(): void;
  getTerminal(): { getSelection(): string };
}

export interface TerminalFindPane {
  instanceId: string;
  error: boolean;
  view: TerminalFindView;
}

export interface TerminalFindBindings {
  termContainer: HTMLElement;
  getActivePane(): TerminalFindPane | undefined;
  getPaneById(id: string): TerminalFindPane | undefined;
}

export function createTerminalFind(bindings: TerminalFindBindings): {
  open(): void;
  close(refocus?: boolean): void;
  dispose(): void;
} {
  const { termContainer } = bindings;
  let findBar: HTMLElement | null = null;
  let findInput: HTMLInputElement | null = null;
  let findCount: HTMLElement | null = null;
  let findPaneId: string | null = null;
  let findResultsSub: { dispose(): void } | null = null;

  function findPane(): TerminalFindPane | undefined {
    const pane = bindings.getActivePane();
    return pane && !pane.error ? pane : undefined;
  }

  function clearFindDecorations(): void {
    if (findPaneId) bindings.getPaneById(findPaneId)?.view.clearFind();
    findPaneId = null;
    findResultsSub?.dispose();
    findResultsSub = null;
    if (findCount) findCount.textContent = "";
  }

  function runTerminalFind(next: boolean): void {
    const pane = findPane();
    const term = findInput?.value ?? "";
    if (!pane || !term) return;
    if (findPaneId !== pane.instanceId) {
      clearFindDecorations();
      findPaneId = pane.instanceId;
      findResultsSub = pane.view.onFindResults((index, count) => {
        if (!findCount) return;
        findCount.textContent = count === 0 ? "no matches" : index < 0 ? `${count}+` : `${index + 1}/${count}`;
      });
    }
    // A throwing search backend shows "error", never a silent no-match.
    try {
      if (next) pane.view.findNext(term);
      else pane.view.findPrevious(term);
    } catch {
      if (findCount) findCount.textContent = "error";
    }
  }

  function closeTerminalFind(refocus = true): void {
    clearFindDecorations();
    if (findBar) findBar.hidden = true;
    if (refocus) findPane()?.view.focus();
  }

  function positionTerminalFindBar(): void {
    if (!findBar) return;
    const rect = termContainer.getBoundingClientRect();
    findBar.style.top = `${rect.top + 8}px`;
    findBar.style.left = `${Math.max(8, rect.right - 328)}px`;
  }

  // The bar anchors to the terminal container, so it follows window resizes,
  // divider drags, and layout changes — not just the open that positioned it.
  const resizeObserver = new ResizeObserver(() => {
    if (findBar && !findBar.hidden) positionTerminalFindBar();
  });
  resizeObserver.observe(termContainer);

  function buildTerminalFindBar(): void {
    const bar = document.createElement("div");
    bar.className = "terminal-find";
    bar.hidden = true;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find in terminal";
    input.setAttribute("aria-label", "Find in terminal");
    const count = document.createElement("span");
    count.className = "terminal-find-count";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "↑";
    prev.title = "Previous match (Shift+Enter)";
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "↓";
    next.title = "Next match (Enter)";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Close (Esc)";
    input.addEventListener("input", () => runTerminalFind(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runTerminalFind(!e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeTerminalFind();
      }
    });
    prev.addEventListener("click", () => {
      runTerminalFind(false);
      input.focus();
    });
    next.addEventListener("click", () => {
      runTerminalFind(true);
      input.focus();
    });
    close.addEventListener("click", () => closeTerminalFind());
    bar.append(input, count, prev, next, close);
    document.body.appendChild(bar);
    findBar = bar;
    findInput = input;
    findCount = count;
  }

  function openTerminalFind(): void {
    const pane = findPane();
    if (!pane) return;
    if (!findBar) buildTerminalFindBar();
    if (findPaneId !== pane.instanceId) clearFindDecorations();
    findBar!.hidden = false;
    positionTerminalFindBar();
    if (findInput) {
      const selection = pane.view.getTerminal().getSelection().trim().split("\n")[0] ?? "";
      if (selection) findInput.value = selection;
      findInput.focus();
      findInput.select();
    }
    if (findInput?.value) runTerminalFind(true);
  }

  return {
    open: openTerminalFind,
    close: closeTerminalFind,
    dispose: () => {
      resizeObserver.disconnect();
      closeTerminalFind(false);
      findBar?.remove();
      findBar = null;
      findInput = null;
      findCount = null;
    },
  };
}
