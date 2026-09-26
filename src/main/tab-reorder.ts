/**
 * Pointer reorder for a tab strip.
 *
 * A click switches. The grabbed tab lifts only after the press is held, then
 * follows the pointer. A slot stays in the strip and moves as the pointer
 * crosses a neighbor's midpoint,
 * and the other tabs slide into the gap before the pointer is released.
 */
import { insertionIndex } from "../../shared/tab-order";

/** A press that is released before this is a click. Drag starts only on a hold. */
const HOLD_MS = 300;

export function attachTabReorder(
  list: HTMLElement,
  opts: {
    tabClass: string;
    canDrag?: (tab: HTMLElement) => boolean;
    onCommit: () => void;
  },
): void {
  let pointerId = -1;
  let tab: HTMLElement | null = null;
  let originNext: ChildNode | null = null;
  let placeholder: HTMLElement | null = null;
  let offsetX = 0;
  let offsetY = 0;
  let dragged = false;
  let suppressClick = false;
  let holdTimer: number | null = null;
  let lastX = 0;
  let lastY = 0;

  const canDrag = opts.canDrag ?? (() => true);

  const clearLift = (el: HTMLElement): void => {
    el.classList.remove("tab-grabbed");
    el.style.left = "";
    el.style.top = "";
    el.style.width = "";
    el.style.height = "";
  };

  const end = (commit: boolean): void => {
    const grabbed = tab;
    const slot = placeholder;
    const next = originNext;
    const didDrag = dragged;
    pointerId = -1;
    tab = null;
    placeholder = null;
    originNext = null;
    dragged = false;
    document.body.classList.remove("tab-reordering");
    if (!grabbed) return;
    clearLift(grabbed);
    if (slot) {
      if (commit && didDrag) slot.replaceWith(grabbed);
      else {
        if (next && next.parentNode === list) list.insertBefore(grabbed, next);
        else list.appendChild(grabbed);
        slot.remove();
      }
    }
    if (commit && didDrag) {
      suppressClick = true;
      opts.onCommit();
    }
  };

  const slide = (move: () => void): void => {
    const tabs = [...list.children].filter((node): node is HTMLElement =>
      node instanceof HTMLElement && node.classList.contains(opts.tabClass),
    );
    const before = new Map(tabs.map((el) => [el, el.getBoundingClientRect().left]));
    move();
    for (const el of tabs) {
      const dx = (before.get(el) ?? 0) - el.getBoundingClientRect().left;
      if (dx === 0) continue;
      el.style.transition = "none";
      el.style.transform = `translateX(${dx}px)`;
      el.getBoundingClientRect();
      el.style.transition = "";
      el.getBoundingClientRect();
      el.style.transform = "";
    }
  };

  const moveSlot = (clientX: number): void => {
    const slot = placeholder;
    if (!slot) return;
    const tabs = [...list.children].filter((node): node is HTMLElement => {
      if (!(node instanceof HTMLElement) || node === slot) return false;
      return node.classList.contains(opts.tabClass) && canDrag(node);
    });
    const index = insertionIndex(
      clientX,
      tabs.map((el) => {
        const rect = el.getBoundingClientRect();
        return { left: rect.left, width: rect.width };
      }),
    );
    const anchor = tabs[index] ?? null;
    if (slot.nextSibling === anchor) return;
    if (!anchor && !slot.nextSibling) return;
    slide(() => list.insertBefore(slot, anchor));
  };

  const clearHold = (): void => {
    if (holdTimer === null) return;
    window.clearTimeout(holdTimer);
    holdTimer = null;
  };

  const lift = (el: HTMLElement, clientX: number, clientY: number): void => {
    const rect = el.getBoundingClientRect();
    originNext = el.nextSibling;
    const slot = document.createElement("div");
    slot.className = "tab-drop-slot";
    slot.style.width = `${rect.width}px`;
    slot.style.height = `${rect.height}px`;
    placeholder = slot;
    el.before(slot);
    offsetX = clientX - rect.left;
    offsetY = clientY - rect.top;
    el.classList.add("tab-grabbed");
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    document.body.appendChild(el);
    document.body.classList.add("tab-reordering");
    dragged = true;
  };

  list.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || tab) return;
    const hit = event.target instanceof Element ? event.target.closest(`.${opts.tabClass}`) : null;
    if (!(hit instanceof HTMLElement) || !list.contains(hit)) return;
    if (event.target instanceof Element && event.target.closest(".tab-close")) return;
    if (!canDrag(hit)) return;
    pointerId = event.pointerId;
    tab = hit;
    lastX = event.clientX;
    lastY = event.clientY;
    dragged = false;
    clearHold();
    // Capture only once the hold becomes a drag. Capturing on press retargets
    // the click to the strip, so the tab's switch handler never runs.
    holdTimer = window.setTimeout(() => {
      holdTimer = null;
      if (!tab || pointerId !== event.pointerId) return;
      lift(tab, lastX, lastY);
      try {
        list.setPointerCapture(event.pointerId);
      } catch {
        // The press already ended; pointerup puts the tab back.
      }
    }, HOLD_MS);
  });

  list.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId || !tab || !dragged) return;
    tab.style.left = `${event.clientX - offsetX}px`;
    tab.style.top = `${event.clientY - offsetY}px`;
    moveSlot(event.clientX);
  });

  const finish = (event: PointerEvent, commit: boolean): void => {
    if (event.pointerId !== pointerId) return;
    clearHold();
    if (!dragged) {
      pointerId = -1;
      tab = null;
      return;
    }
    if (list.hasPointerCapture(event.pointerId)) list.releasePointerCapture(event.pointerId);
    end(commit);
  };

  window.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId || dragged) return;
    lastX = event.clientX;
    lastY = event.clientY;
  });
  window.addEventListener("pointerup", (event) => finish(event, true));
  window.addEventListener("pointercancel", (event) => finish(event, false));

  list.addEventListener("pointerup", (event) => finish(event, true));
  list.addEventListener("pointercancel", (event) => finish(event, false));
  list.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (dragged || holdTimer !== null)) {
      clearHold();
      if (list.hasPointerCapture(pointerId)) list.releasePointerCapture(pointerId);
      if (dragged) end(false);
      else {
        pointerId = -1;
        tab = null;
      }
    }
  });
}
