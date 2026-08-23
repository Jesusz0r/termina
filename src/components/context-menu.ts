/**
 * One shared right-click menu: fixed-position item list with keyboard
 * navigation (arrows, Enter, Escape) and click-away close. The caller
 * supplies plain items; rendering, positioning, and teardown live here.
 */

export interface ContextMenuItem {
  label?: string;
  action?: () => void;
  /** A full-width rule; ignores label/action. */
  separator?: boolean;
  /** Rendered dimmed and skipped by keyboard navigation. */
  disabled?: boolean;
}

let open: { el: HTMLElement; cleanup: () => void } | null = null;

/** Close the currently open context menu, if any. */
export function closeContextMenu(): void {
  open?.cleanup();
}

export function showContextMenu(items: ContextMenuItem[], x: number, y: number): void {
  closeContextMenu();

  const menu = document.createElement("div");
  menu.className = "context-menu";
  const rows: Array<{ el: HTMLElement; item: ContextMenuItem }> = [];

  for (const item of items) {
    if (item.separator) {
      const rule = document.createElement("div");
      rule.className = "context-menu-separator";
      menu.appendChild(rule);
      continue;
    }
    const row = document.createElement("div");
    row.className = "context-menu-item";
    if (item.disabled) row.classList.add("disabled");
    row.textContent = item.label ?? "";
    rows.push({ el: row, item });
    menu.appendChild(row);
  }

  let index = rows.findIndex((r) => !r.item.disabled);
  const paint = () => {
    for (const [i, row] of rows.entries()) row.el.classList.toggle("selected", i === index);
  };
  paint();
  const run = (row: { el: HTMLElement; item: ContextMenuItem }) => {
    if (row.item.disabled || !row.item.action) return;
    cleanup();
    row.item.action();
  };

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") return cleanup();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const enabled = rows.map((r, i) => (r.item.disabled ? -1 : i)).filter((i) => i !== -1);
      if (enabled.length === 0) return;
      const at = enabled.indexOf(index);
      index = e.key === "ArrowDown" ? enabled[(at + 1) % enabled.length] : enabled[(at - 1 + enabled.length) % enabled.length];
      paint();
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && index !== -1) run(rows[index]);
  };
  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) cleanup();
  };
  const onWheelOrResize = (e: Event) => {
    // A wheel over the menu itself scrolls the menu; only a wheel elsewhere
    // dismisses it.
    if (e.type === "wheel" && menu.contains(e.target as Node)) return;
    cleanup();
  };

  function cleanup() {
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("mousedown", onOutside, true);
    window.removeEventListener("wheel", onWheelOrResize);
    window.removeEventListener("resize", onWheelOrResize);
    menu.remove();
    if (open?.el === menu) open = null;
  }

  // Rows react to hover; keyboard selection paints over it.
  for (const [i, row] of rows.entries()) {
    row.el.addEventListener("mouseenter", () => {
      index = row.item.disabled ? -1 : i;
      paint();
    });
    row.el.addEventListener("click", () => run(row));
  }

  document.body.appendChild(menu);
  // Keep the menu on screen: clamp against the viewport edges.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;

  document.addEventListener("keydown", onKey, true);
  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("wheel", onWheelOrResize, { passive: true });
  window.addEventListener("resize", onWheelOrResize);
  open = { el: menu, cleanup };
}
