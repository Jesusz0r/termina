import {
  DEFAULT_SHORTCUTS,
  defaultAppPreferences,
  type AppPreferences,
  type ShortcutCommand,
  type ShortcutMap,
  type ThemeId,
} from "../shared/types";

interface SettingsCallbacks {
  onChange: (preferences: AppPreferences) => void;
  onOpen: () => void;
  onClose: (preferences: AppPreferences) => void;
}

const SHORTCUTS: Array<{ command: ShortcutCommand; label: string; description: string }> = [
  { command: "open-folder", label: "Open folder", description: "Choose a project folder" },
  { command: "new-file", label: "New file", description: "Create a file in the explorer" },
  { command: "new-folder", label: "New folder", description: "Create a folder in the explorer" },
  { command: "rename", label: "Rename", description: "Rename the selected explorer entry" },
  { command: "delete", label: "Delete", description: "Delete the selected explorer entry" },
  { command: "refresh", label: "Refresh explorer", description: "Reload the file tree" },
  { command: "save-all", label: "Save all", description: "Save every dirty editor" },
  { command: "close-window", label: "Close window", description: "Close the application window" },
  { command: "undo", label: "Undo", description: "Undo in the focused surface" },
  { command: "redo", label: "Redo", description: "Redo in the focused surface" },
  { command: "select-all", label: "Select all", description: "Select all in the focused surface" },
  { command: "new-terminal", label: "New terminal", description: "Open a shell or Pi terminal" },
  { command: "close-terminal", label: "Close terminal", description: "Close the active terminal" },
  { command: "abort-terminal", label: "Abort terminal", description: "Send an interrupt to the active terminal" },
  { command: "fullscreen", label: "Terminal fullscreen", description: "Show only the terminal" },
  { command: "toggle-explorer", label: "Toggle explorer", description: "Show or hide the file explorer" },
  { command: "toggle-editor", label: "Toggle editor", description: "Show or hide the editor" },
  { command: "toggle-modified", label: "Toggle modified panel", description: "Show or hide changed files" },
  { command: "session-search", label: "Search sessions", description: "Search previous Pi sessions" },
  { command: "open-settings", label: "Open settings", description: "Open this preferences window" },
];

const THEME_OPTIONS: Array<{ id: ThemeId; label: string; description: string }> = [
  { id: "dark", label: "Obsidian", description: "The default dark workspace" },
  { id: "light", label: "Paper", description: "A bright, low-glare workspace" },
  { id: "high-contrast", label: "Signal", description: "Strong contrast for clear edges" },
];

export function emptyShortcuts(): ShortcutMap {
  const result = {} as ShortcutMap;
  for (const item of SHORTCUTS) result[item.command] = "";
  return result;
}

export function formatShortcut(value: string): string {
  if (!value) return "Not set";
  const mac = navigator.platform.toUpperCase().includes("MAC");
  const labels: Record<string, string> = mac
    ? { CmdOrCtrl: "⌘", Command: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Enter: "↵", Escape: "Esc", Backspace: "⌫", Delete: "⌦", Up: "↑", Down: "↓", Left: "←", Right: "→", Space: "Space" }
    : { CmdOrCtrl: "Ctrl", Command: "Ctrl", Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Enter: "Enter", Escape: "Esc", Backspace: "Backspace", Delete: "Delete", Up: "↑", Down: "↓", Left: "←", Right: "→", Space: "Space" };
  const parts = value.split("+").map((part) => labels[part] ?? part);
  return mac ? parts.join("") : parts.join("+");
}

function keyForEvent(event: KeyboardEvent): string | null {
  const code = event.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  const keys: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Escape: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
  };
  return keys[code] ?? null;
}

function shortcutForEvent(event: KeyboardEvent): string | null {
  const key = keyForEvent(event);
  if (!key || ["Shift", "Control", "Alt", "Meta"].includes(event.key)) return null;
  const mac = navigator.platform.toUpperCase().includes("MAC");
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("CmdOrCtrl");
  else if (event.ctrlKey) modifiers.push(mac ? "Ctrl" : "CmdOrCtrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (modifiers.length === 0 && !key.startsWith("F")) return null;
  return [...modifiers, key].join("+");
}

function copyPreferences(preferences: AppPreferences): AppPreferences {
  return { ...preferences, shortcuts: { ...preferences.shortcuts } };
}

export class SettingsView {
  private preferences: AppPreferences;
  private backdrop: HTMLElement | null = null;
  private activeSection: "appearance" | "shortcuts" = "appearance";
  private recording: ShortcutCommand | null = null;
  private captureError: string | null = null;

  constructor(private readonly callbacks: SettingsCallbacks) {
    this.preferences = defaultAppPreferences();
  }

  open(preferences: AppPreferences): void {
    if (this.backdrop) {
      this.backdrop.focus();
      return;
    }
    this.preferences = copyPreferences(preferences);
    this.recording = null;
    this.captureError = null;
    this.activeSection = "appearance";
    this.callbacks.onOpen();

    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop";
    backdrop.tabIndex = -1;
    backdrop.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.recording) this.close();
    });
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) this.close();
    });

    const modal = document.createElement("section");
    modal.className = "settings-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Settings");
    backdrop.appendChild(modal);
    this.backdrop = backdrop;
    document.getElementById("modal-root")!.appendChild(backdrop);
    backdrop.focus();
    this.render(modal);
  }

  close(): void {
    if (!this.backdrop) return;
    const current = this.preferences;
    this.backdrop.remove();
    this.backdrop = null;
    this.recording = null;
    this.callbacks.onClose(current);
  }

  private notify(): void {
    this.callbacks.onChange(copyPreferences(this.preferences));
  }

  private render(modal: HTMLElement): void {
    modal.replaceChildren();

    const header = document.createElement("header");
    header.className = "settings-header";
    const heading = document.createElement("div");
    heading.innerHTML = '<span class="settings-kicker">PI / DITOR</span><h2>Settings</h2>';
    const close = document.createElement("button");
    close.className = "settings-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Close settings";
    close.addEventListener("click", () => this.close());
    header.append(heading, close);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.className = "settings-body";
    const nav = document.createElement("nav");
    nav.className = "settings-nav";
    for (const section of ["appearance", "shortcuts"] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `settings-nav-item${this.activeSection === section ? " active" : ""}`;
      button.textContent = section === "appearance" ? "Appearance" : "Keyboard";
      button.addEventListener("click", () => {
        this.activeSection = section;
        this.captureError = null;
        this.render(modal);
      });
      nav.appendChild(button);
    }
    const main = document.createElement("main");
    main.className = "settings-content";
    if (this.activeSection === "appearance") this.renderAppearance(main);
    else this.renderShortcuts(main);
    body.append(nav, main);
    modal.appendChild(body);

    const footer = document.createElement("footer");
    footer.className = "settings-footer";
    const hint = document.createElement("span");
    hint.className = "settings-footer-hint";
    hint.textContent = "Changes apply immediately";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "settings-reset";
    reset.textContent = "Reset all";
    reset.addEventListener("click", () => {
      this.preferences = defaultAppPreferences();
      this.recording = null;
      this.captureError = null;
      this.notify();
      this.render(modal);
    });
    footer.append(hint, reset);
    modal.appendChild(footer);
  }

  private renderAppearance(content: HTMLElement): void {
    content.appendChild(this.sectionHeading("Appearance", "Tune the surface without changing your project."));

    const themeGrid = document.createElement("div");
    themeGrid.className = "settings-theme-grid";
    for (const theme of THEME_OPTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `settings-theme-card${this.preferences.theme === theme.id ? " selected" : ""}`;
      button.dataset.theme = theme.id;
      button.innerHTML = `<span class="theme-swatch"></span><strong>${theme.label}</strong><small>${theme.description}</small>`;
      button.addEventListener("click", () => {
        this.preferences.theme = theme.id;
        this.notify();
        this.render(this.backdrop!.querySelector(".settings-modal") as HTMLElement);
      });
      themeGrid.appendChild(button);
    }
    content.appendChild(this.settingGroup("Color system", themeGrid));

    const fontRow = document.createElement("div");
    fontRow.className = "settings-inline-control";
    const fontLabel = document.createElement("label");
    fontLabel.textContent = "Editor font size";
    const fontValue = document.createElement("output");
    fontValue.textContent = `${this.preferences.editorFontSize}px`;
    const font = document.createElement("input");
    font.type = "range";
    font.min = "10";
    font.max = "20";
    font.step = "1";
    font.value = String(this.preferences.editorFontSize);
    font.addEventListener("input", () => {
      this.preferences.editorFontSize = Number(font.value);
      fontValue.textContent = `${this.preferences.editorFontSize}px`;
      this.notify();
    });
    fontRow.append(fontLabel, font, fontValue);
    content.appendChild(this.settingGroup("Editor", fontRow));

    const miniRow = document.createElement("label");
    miniRow.className = "settings-check-row";
    const minimap = document.createElement("input");
    minimap.type = "checkbox";
    minimap.checked = this.preferences.minimap;
    minimap.addEventListener("change", () => {
      this.preferences.minimap = minimap.checked;
      this.notify();
    });
    const miniText = document.createElement("span");
    miniText.innerHTML = "<strong>Show minimap</strong><small>Keep the code map visible in the editor.</small>";
    miniRow.append(minimap, miniText);
    content.appendChild(miniRow);
  }

  private renderShortcuts(content: HTMLElement): void {
    content.appendChild(this.sectionHeading("Keyboard shortcuts", "Select a shortcut to record a new key combination."));
    const list = document.createElement("div");
    list.className = "settings-shortcut-list";
    for (const item of SHORTCUTS) {
      const row = document.createElement("div");
      row.className = "settings-shortcut-row";
      const copy = document.createElement("div");
      copy.className = "settings-shortcut-copy";
      const label = document.createElement("strong");
      label.textContent = item.label;
      const description = document.createElement("small");
      description.textContent = item.description;
      copy.append(label, description);
      const capture = document.createElement("button");
      capture.type = "button";
      capture.className = `settings-shortcut-capture${this.recording === item.command ? " recording" : ""}`;
      capture.textContent = this.recording === item.command ? this.captureError ?? "Press a key…" : formatShortcut(this.preferences.shortcuts[item.command]);
      capture.title = "Click, then press the new shortcut";
      capture.addEventListener("click", () => {
        this.recording = item.command;
        this.captureError = null;
        this.render(this.backdrop!.querySelector(".settings-modal") as HTMLElement);
        (this.backdrop!.querySelector(`[data-shortcut="${item.command}"]`) as HTMLElement | null)?.focus();
      });
      capture.dataset.shortcut = item.command;
      capture.addEventListener("keydown", (event) => {
        if (this.recording !== item.command) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
          this.recording = null;
          this.captureError = null;
          this.render(this.backdrop!.querySelector(".settings-modal") as HTMLElement);
          return;
        }
        if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          this.preferences.shortcuts[item.command] = "";
          this.recording = null;
          this.captureError = null;
          this.notify();
          this.render(this.backdrop!.querySelector(".settings-modal") as HTMLElement);
          return;
        }
        const value = shortcutForEvent(event);
        if (!value) {
          this.captureError = "Use a modifier key";
          this.render(this.backdrop!.querySelector(".settings-modal") as HTMLElement);
          (this.backdrop!.querySelector(`[data-shortcut="${item.command}"]`) as HTMLElement | null)?.focus();
          return;
        }
        const conflict = SHORTCUTS.find((other) => other.command !== item.command && this.preferences.shortcuts[other.command] === value);
        if (conflict) {
          this.captureError = `Used by ${conflict.label}`;
          this.render(this.backdrop!.querySelector(".settings-modal") as HTMLElement);
          (this.backdrop!.querySelector(`[data-shortcut="${item.command}"]`) as HTMLElement | null)?.focus();
          return;
        }
        this.preferences.shortcuts[item.command] = value;
        this.recording = null;
        this.captureError = null;
        this.notify();
        this.render(this.backdrop!.querySelector(".settings-modal") as HTMLElement);
      });
      row.append(copy, capture);
      list.appendChild(row);
    }
    content.appendChild(list);
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "settings-reset-shortcuts";
    reset.textContent = "Restore default shortcuts";
    reset.addEventListener("click", () => {
      this.preferences.shortcuts = { ...DEFAULT_SHORTCUTS };
      this.recording = null;
      this.captureError = null;
      this.notify();
      this.render(this.backdrop!.querySelector(".settings-modal") as HTMLElement);
    });
    content.appendChild(reset);
  }

  private sectionHeading(title: string, description: string): HTMLElement {
    const heading = document.createElement("div");
    heading.className = "settings-section-heading";
    const titleEl = document.createElement("h3");
    titleEl.textContent = title;
    const descriptionEl = document.createElement("p");
    descriptionEl.textContent = description;
    heading.append(titleEl, descriptionEl);
    return heading;
  }

  private settingGroup(label: string, body: HTMLElement): HTMLElement {
    const group = document.createElement("section");
    group.className = "settings-group";
    const labelEl = document.createElement("h4");
    labelEl.textContent = label;
    group.append(labelEl, body);
    return group;
  }
}
