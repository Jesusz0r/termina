/**
 * Modal dialogs for pi's extension UI protocol (select/confirm/input/editor)
 * and generic toasts for notifications.
 */

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

export function showInput(title: string, placeholder: string, prefill: string): Promise<ModalResult> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder ?? "";
    input.value = prefill ?? "";
    makeModal(title, "", [
      { label: "Cancel", primary: false, onClick: () => resolve({ cancelled: true }) },
      { label: "OK", primary: true, onClick: () => resolve({ cancelled: false, value: input.value }) },
    ], input);
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

// ------------------------------------------------------------------- toasts --

export function toast(message: string, type: "info" | "warning" | "error" = "info"): void {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
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
