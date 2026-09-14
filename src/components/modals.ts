/**
 * Modal dialogs for pi's extension UI protocol (select/confirm/input/editor)
 * and generic toasts for notifications.
 */

import type { UnsavedCloseChoice } from "../../shared/unsaved-close";

interface ModalResult {
  cancelled?: boolean;
  value?: string;
  confirmed?: boolean;
}

const root = document.getElementById("modal-root")!;

export function showConfirm(title: string, message: string): Promise<ModalResult> {
  return new Promise((resolve) => {
    makeModal(title, message, [
      { label: "Cancel", primary: false, onClick: () => resolve({ cancelled: true }) },
      { label: "OK", primary: true, onClick: () => resolve({ confirmed: true }) },
    ]);
  });
}

/** Save / Discard / Cancel for dirty editor buffers. Esc still hits Cancel. */
export function showUnsavedConfirm(title: string, message: string): Promise<UnsavedCloseChoice> {
  return new Promise((resolve) => {
    makeModal(title, message, [
      { label: "Cancel", primary: false, onClick: () => resolve("cancel") },
      { label: "Discard", primary: false, onClick: () => resolve("discard") },
      { label: "Save", primary: true, onClick: () => resolve("save") },
    ]);
  });
}

export function showInput(title: string, placeholder: string, prefill: string): Promise<ModalResult> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder ?? "";
    input.value = prefill ?? "";
    const modal = makeModal(title, "", [
      { label: "Cancel", primary: false, onClick: () => resolve({ cancelled: true }) },
      { label: "OK", primary: true, onClick: () => resolve({ cancelled: false, value: input.value }) },
    ], input);
    // Enter confirms through the OK button's own close+resolve path, so
    // keyboard users can complete create/rename without tabbing to OK.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      (modal.querySelector(".modal-btn.primary") as HTMLElement | null)?.click();
    });
    input.focus();
  });
}

// --------------------------------------------------------------- modal core --

interface ModalButton {
  label: string;
  primary: boolean;
  onClick: () => void;
}

function makeModal(title: string, message: string, buttons: ModalButton[], bodyEl?: HTMLElement): HTMLElement {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.tabIndex = -1;

  // Esc cancels: click the first Cancel button if present.
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const cancel = [...modal.querySelectorAll(".modal-btn")].find((b) => b.textContent === "Cancel") as HTMLElement | undefined;
      if (cancel) cancel.click();
    }
  });

  const modal = document.createElement("div");
  modal.className = "modal";

  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.textContent = title;
  modal.appendChild(titleEl);

  const body = document.createElement("div");
  body.className = "modal-body";
  if (message) {
    const p = document.createElement("p");
    p.textContent = message;
    body.appendChild(p);
  }
  if (bodyEl) body.appendChild(bodyEl);
  modal.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `modal-btn${b.primary ? " primary" : ""}`;
    btn.textContent = b.label;
    btn.addEventListener("click", () => {
      close(backdrop);
      b.onClick();
    });
    footer.appendChild(btn);
  }
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  root.appendChild(backdrop);
  backdrop.focus();
  return modal;
}

function close(backdrop: HTMLElement): void {
  backdrop.remove();
}

// -------------------------------------------------------------- focus trap --

/** Focusables for the modal Tab trap (buttons, fields, and tab stops). */
const FOCUS_TRAP_SELECTOR =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The topmost open modal backdrop, if any (#modal-root stacks them in order). */
function topmostBackdrop(): HTMLElement | null {
  const backdrops = root.querySelectorAll(".modal-backdrop, .settings-backdrop");
  return (backdrops[backdrops.length - 1] as HTMLElement | undefined) ?? null;
}

/** Trap Tab inside the topmost modal backdrop, so keyboard focus cannot leave
 *  for the background tree or editor. Installed once: every modal backdrop
 *  (makeModal, file-list, settings) lives in #modal-root. Only keystrokes
 *  already inside the backdrop are trapped — background surfaces keep Tab. */
function trapTab(event: KeyboardEvent): void {
  if (event.key !== "Tab" || event.defaultPrevented) return;
  const top = topmostBackdrop();
  if (!top || !top.contains(event.target as Node | null)) return;
  const focusables = [...top.querySelectorAll<HTMLElement>(FOCUS_TRAP_SELECTOR)];
  if (focusables.length === 0) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement as HTMLElement | null;
  const at = active ? focusables.indexOf(active) : -1;
  if (event.shiftKey && at <= 0) {
    event.preventDefault();
    focusables[focusables.length - 1].focus();
  } else if (!event.shiftKey && (at === -1 || at === focusables.length - 1)) {
    event.preventDefault();
    focusables[0].focus();
  }
}

document.addEventListener("keydown", trapTab, true);

// ------------------------------------------------------------------- toasts --

/** Stacked toast container (one fixed slot; rapid toasts pile vertically). */
let toastContainer: HTMLElement | null = null;

function ensureToastContainer(): HTMLElement {
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.className = "toast-container";
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

export function toast(message: string, type: "info" | "warning" | "error" = "info"): void {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  ensureToastContainer().appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/** Copy text and report the result with a toast. */
export function copyText(text: string, okMessage: string): void {
  navigator.clipboard.writeText(text)
    .then(() => toast(okMessage, "info"))
    .catch(() => toast("could not copy the path", "error"));
}

/** A small modal with a clickable file list. */
export function showFileListModal(
  title: string,
  items: Array<[string, "created" | "modified" | "deleted"]>,
  onPick: (relPath: string) => void,
): void {
  const root = document.getElementById("modal-root")!;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.tabIndex = -1;
  const modal = document.createElement("div");
  modal.className = "modal worldline-list-modal";
  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.textContent = title;
  const body = document.createElement("div");
  body.className = "modal-body";
  const list = document.createElement("ul");
  list.className = "worldline-list";
  for (const [relPath, status] of items) {
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = `status-badge ${status}`;
    badge.textContent = status === "created" ? "A" : status === "deleted" ? "D" : "M";
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = relPath;
    li.append(badge, path);
    li.addEventListener("click", () => {
      backdrop.remove();
      onPick(relPath);
    });
    list.appendChild(li);
  }
  body.appendChild(list);
  const footer = document.createElement("div");
  footer.className = "modal-footer";
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-btn";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", () => backdrop.remove());
  footer.appendChild(closeBtn);
  modal.append(titleEl, body, footer);
  backdrop.append(modal);
  root.appendChild(backdrop);
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") backdrop.remove();
  });
  backdrop.focus();
}
