/**
 * Confirm, unsaved-close, input, and file-list modals, plus generic toasts.
 */

import type { UnsavedCloseChoice } from "../../shared/unsaved-close";
import { asKnownState, KNOWN_FILE_STATUSES } from "../known-state";

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
    ], undefined, { role: "alertdialog" });
  });
}

/** Save / Discard / Cancel for dirty editor buffers. Esc still hits Cancel. */
export function showUnsavedConfirm(title: string, message: string): Promise<UnsavedCloseChoice> {
  return new Promise((resolve) => {
    makeModal(title, message, [
      { label: "Cancel", primary: false, onClick: () => resolve("cancel") },
      { label: "Discard", primary: false, onClick: () => resolve("discard") },
      { label: "Save", primary: true, onClick: () => resolve("save") },
    ], undefined, { role: "alertdialog" });
  });
}

export function showInput(title: string, placeholder: string, prefill: string): Promise<ModalResult> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder ?? "";
    input.value = prefill ?? "";
    const { modal } = makeModal(title, "", [
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

interface MakeModalOptions {
  role?: "dialog" | "alertdialog";
  className?: string;
}

let titleSeq = 0;

function makeModal(
  title: string,
  message: string,
  buttons: ModalButton[],
  bodyEl?: HTMLElement,
  options?: MakeModalOptions,
): { modal: HTMLElement; close: () => void } {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.tabIndex = -1;

  const modal = document.createElement("div");
  modal.className = options?.className ? `modal ${options.className}` : "modal";
  modal.setAttribute("role", options?.role ?? "dialog");
  modal.setAttribute("aria-modal", "true");

  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.id = `modal-title-${++titleSeq}`;
  titleEl.textContent = title;
  modal.setAttribute("aria-labelledby", titleEl.id);
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

  const dismiss = (): void => {
    close(backdrop, previous);
  };

  // Esc dismisses: Cancel if present, otherwise Close (file-list).
  backdrop.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const actions = [...modal.querySelectorAll(".modal-btn")] as HTMLElement[];
    const cancel = actions.find((b) => b.textContent === "Cancel")
      ?? actions.find((b) => b.textContent === "Close");
    cancel?.click();
  });

  const footer = document.createElement("div");
  footer.className = "modal-footer";
  for (const b of buttons) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `modal-btn${b.primary ? " primary" : ""}`;
    btn.textContent = b.label;
    btn.addEventListener("click", () => {
      dismiss();
      b.onClick();
    });
    footer.appendChild(btn);
  }
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  root.appendChild(backdrop);
  backdrop.focus();
  return { modal, close: dismiss };
}

function close(backdrop: HTMLElement, previous: HTMLElement | null): void {
  backdrop.remove();
  if (previous?.isConnected) previous.focus();
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
 *  (makeModal, settings) lives in #modal-root. Only keystrokes already inside
 *  the backdrop are trapped — background surfaces keep Tab. */
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
    toastContainer.setAttribute("role", "status");
    toastContainer.setAttribute("aria-live", "polite");
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

/** Stays until dismiss(). Reuses the toast stack; optional Retry-style action. */
export function stickyToast(
  message: string,
  type: "warning" | "error" | "info" = "info",
  action?: { label: string; onClick: () => void },
): { dismiss: () => void } {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", action.onClick);
    el.appendChild(btn);
  }
  ensureToastContainer().appendChild(el);
  return {
    dismiss() {
      el.remove();
    },
  };
}

/** Copy text and report the result with a toast. */
export function copyText(text: string, okMessage: string): void {
  navigator.clipboard.writeText(text)
    .then(() => toast(okMessage, "info"))
    .catch(() => toast("could not copy the path", "error"));
}

/** Rendered cap for file-list modals (worldline Compare). The title keeps the
 *  true total; the overflow note says the listing is truncated. */
export const MAX_FILE_LIST_MODAL_ROWS = 1000;

/** A small modal with a clickable file list. */
export function showFileListModal(
  title: string,
  items: Array<[string, "created" | "modified" | "deleted"]>,
  onPick: (relPath: string) => void,
  listing?: { truncated?: boolean; total?: number },
): void {
  const list = document.createElement("ul");
  list.className = "worldline-list";
  const shown = items.slice(0, MAX_FILE_LIST_MODAL_ROWS);
  for (const [relPath, status] of shown) {
    const li = document.createElement("li");
    const badge = document.createElement("span");
    const safe = asKnownState(status, KNOWN_FILE_STATUSES);
    badge.className = `status-badge ${safe}`;
    badge.textContent = safe === "created" ? "A" : safe === "deleted" ? "D" : safe === "modified" ? "M" : "?";
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = relPath;
    li.append(badge, path);
    list.appendChild(li);
  }
  const shownCount = shown.length;
  const total = listing?.total ?? items.length;
  if (listing?.truncated === true || total > shownCount || items.length > MAX_FILE_LIST_MODAL_ROWS) {
    const more = document.createElement("li");
    more.className = "worldline-more";
    more.textContent = total > shownCount
      ? `…first ${shownCount} of ${total} — listing truncated`
      : `…listing truncated — showing first ${shownCount}`;
    list.appendChild(more);
  }
  const { close: dismiss } = makeModal(title, "", [
    { label: "Close", primary: false, onClick: () => {} },
  ], list, { className: "worldline-list-modal" });
  for (let i = 0; i < shown.length; i++) {
    const relPath = shown[i][0];
    list.children[i].addEventListener("click", () => {
      dismiss();
      onPick(relPath);
    });
  }
}
