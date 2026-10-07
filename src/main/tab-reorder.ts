/** Pointer reorder shared by project and terminal strips. Clicks still switch tabs. */
import { insertionIndex } from "../../shared/tab-order";

const DRAG_DISTANCE = 5;

export function attachTabReorder(
  list: HTMLElement,
  opts: {
    tabClass: string;
    axis?: "horizontal" | "vertical";
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
  let startX = 0;
  let startY = 0;
  let suppressClick = false;
  let targets: { el: HTMLElement; start: number; size: number }[] = [];
  let startScroll = 0;

  const vertical = opts.axis === "vertical";
  const rectStart = vertical ? "top" : "left";
  const rectSize = vertical ? "height" : "width";
  const scrollPosition = vertical ? "scrollTop" : "scrollLeft";
  const pointerPosition = (event: PointerEvent): number => vertical ? event.clientY : event.clientX;
  const canDrag = opts.canDrag ?? (() => true);

  const end = (commit: boolean): void => {
    const grabbed = tab;
    const slot = placeholder;
    const next = originNext;
    const capturedId = pointerId;
    pointerId = -1;
    tab = null;
    placeholder = null;
    originNext = null;
    targets = [];
    if (list.hasPointerCapture(capturedId)) list.releasePointerCapture(capturedId);
    if (!grabbed || !slot) return;
    document.body.classList.remove("tab-reordering");
    grabbed.classList.remove("tab-grabbed");
    grabbed.style.left = "";
    grabbed.style.top = "";
    grabbed.style.width = "";
    grabbed.style.height = "";
    if (commit) slot.replaceWith(grabbed);
    else {
      if (next && next.parentNode === list) list.insertBefore(grabbed, next);
      else list.appendChild(grabbed);
      slot.remove();
    }
    // Suppress only this gesture's click; the next pointerdown clears it even
    // when cancellation/capture loss means the browser never emits a click.
    suppressClick = true;
    if (commit) opts.onCommit();
  };

  const slide = (move: () => void): void => {
    const tabs = targets.map(({ el }) => el);
    const before = new Map(tabs.map((el) => [el, el.getBoundingClientRect()[rectStart]]));
    move();
    for (const el of tabs) {
      el.style.transition = "none";
      el.style.transform = "";
      const delta = (before.get(el) ?? 0) - el.getBoundingClientRect()[rectStart];
      el.style.transform = `${vertical ? "translateY" : "translateX"}(${delta}px)`;
      el.getBoundingClientRect();
      el.style.transition = "";
      el.style.transform = "";
    }
  };

  const moveSlot = (position: number): void => {
    const slot = placeholder;
    if (!slot) return;
    // Keep hit targets in their original content coordinates. Measuring the
    // animated neighbors makes the slot oscillate under a stationary pointer.
    const index = insertionIndex(position + list[scrollPosition] - startScroll, targets);
    const anchor = targets[index]?.el ?? null;
    if (slot.nextSibling === anchor) return;
    slide(() => list.insertBefore(slot, anchor));
  };

  const lift = (el: HTMLElement): void => {
    const rect = el.getBoundingClientRect();
    startScroll = list[scrollPosition];
    targets = [...list.children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement
        && node !== el && node.classList.contains(opts.tabClass) && canDrag(node))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, start: rect[rectStart], size: rect[rectSize] };
      });
    originNext = el.nextSibling;
    const slot = document.createElement("div");
    slot.className = "tab-drop-slot";
    slot.style.width = `${rect.width}px`;
    slot.style.height = `${rect.height}px`;
    placeholder = slot;
    el.before(slot);
    offsetX = startX - rect.left;
    offsetY = startY - rect.top;
    el.classList.add("tab-grabbed");
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    document.body.appendChild(el);
    document.body.classList.add("tab-reordering");
    // Capture after reparenting. Capturing on press would retarget normal
    // clicks to the strip instead of the tab's switch handler.
    list.setPointerCapture(pointerId);
  };

  list.addEventListener("pointerdown", (event) => {
    suppressClick = false;
    if (event.button !== 0 || !event.isPrimary || tab) return;
    const hit = event.target instanceof Element ? event.target.closest(`.${opts.tabClass}`) : null;
    if (!(hit instanceof HTMLElement) || !list.contains(hit)) return;
    if (event.target instanceof Element && event.target.closest(".tab-close")) return;
    if (!canDrag(hit)) return;
    pointerId = event.pointerId;
    tab = hit;
    startX = event.clientX;
    startY = event.clientY;
  });

  window.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId || !tab) return;
    if ((event.buttons & 1) === 0 || !list.isConnected || !canDrag(tab)) {
      end(false);
      return;
    }
    if (!placeholder) {
      if (!list.contains(tab)) {
        end(false);
        return;
      }
      if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_DISTANCE) return;
      lift(tab);
    }
    tab.style.left = `${event.clientX - offsetX}px`;
    tab.style.top = `${event.clientY - offsetY}px`;
    moveSlot(pointerPosition(event));
  });

  window.addEventListener("pointerup", (event) => {
    if (event.pointerId !== pointerId) return;
    moveSlot(pointerPosition(event));
    end(true);
  });
  window.addEventListener("pointercancel", (event) => {
    if (event.pointerId === pointerId) end(false);
  });
  list.addEventListener("lostpointercapture", (event) => {
    if (event.pointerId === pointerId) end(false);
  });
  list.addEventListener("click", (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  window.addEventListener("blur", () => end(false));
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") end(false);
  });
}
