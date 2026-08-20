import {
  CODE_FONT_FAMILIES,
  DEFAULT_SHORTCUTS,
  defaultAppPreferences,
  type AppPreferences,
  type CodeFontFamily,
  type ShortcutCommand,
  type ThemeId,
} from "../shared/types";
import { normalizeAppPreferences } from "../shared/preferences";
import { SHORTCUTS, emptyShortcuts, formatShortcut, shortcutForEvent } from "./settings-shortcuts";

export { emptyShortcuts };

interface SettingsCallbacks {
  onChange: (preferences: AppPreferences) => void;
  onOpen: () => void;
  onClose: (preferences: AppPreferences) => void;
}

const THEME_OPTIONS: Array<{ id: ThemeId; label: string; description: string }> = [
  { id: "dark", label: "Obsidian", description: "The default dark workspace" },
  { id: "atom", label: "Atom", description: "One Dark from the Atom editor" },
  { id: "light", label: "Paper", description: "A bright, low-glare workspace" },
  { id: "high-contrast", label: "Signal", description: "Strong contrast for clear edges" },
];

function copyPreferences(preferences: AppPreferences): AppPreferences {
  return normalizeAppPreferences(preferences);
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
      if (event.key !== "Escape") return;
      if (this.recording) this.cancelRecording();
      else this.close();
    });
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target !== backdrop) return;
      if (this.recording) this.cancelRecording();
      else this.close();
    });

    const modal = document.createElement("section");
    modal.className = "settings-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "settings-title");
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

  private cancelRecording(): void {
    if (!this.recording && !this.captureError) return;
    this.recording = null;
    this.captureError = null;
    const modal = this.backdrop?.querySelector(".settings-modal");
    if (modal instanceof HTMLElement) this.render(modal);
  }

  private render(modal: HTMLElement): void {
    modal.replaceChildren();

    const header = document.createElement("header");
    header.className = "settings-header";
    const heading = document.createElement("h2");
    heading.id = "settings-title";
    heading.textContent = "Settings";
    const close = document.createElement("button");
    close.className = "settings-close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Close settings";
    close.setAttribute("aria-label", "Close settings");
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

    const typeGroup = document.createElement("div");
    typeGroup.append(
      this.fontSizeRow("Editor font size", "editorFontSize"),
      this.fontSizeRow("Terminal font size", "terminalFontSize"),
      this.fontFamilyRow(),
    );
    content.appendChild(this.settingGroup("Type", typeGroup));

    const wrapRow = document.createElement("label");
    wrapRow.className = "settings-check-row";
    const wrap = document.createElement("input");
    wrap.type = "checkbox";
    wrap.checked = this.preferences.wordWrap;
    wrap.addEventListener("change", () => {
      this.preferences.wordWrap = wrap.checked;
      this.notify();
    });
    const wrapText = document.createElement("span");
    wrapText.innerHTML = "<strong>Word wrap</strong><small>Wrap long lines in the editor and review.</small>";
    wrapRow.append(wrap, wrapText);
    content.appendChild(wrapRow);

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

  private fontSizeRow(label: string, key: "editorFontSize" | "terminalFontSize"): HTMLElement {
    const row = document.createElement("div");
    row.className = "settings-inline-control";
    const fontLabel = document.createElement("label");
    fontLabel.textContent = label;
    const fontValue = document.createElement("output");
    fontValue.textContent = `${this.preferences[key]}px`;
    const font = document.createElement("input");
    font.type = "range";
    font.min = "10";
    font.max = "20";
    font.step = "1";
    font.value = String(this.preferences[key]);
    font.addEventListener("input", () => {
      this.preferences[key] = Number(font.value);
      fontValue.textContent = `${this.preferences[key]}px`;
      this.notify();
    });
    row.append(fontLabel, font, fontValue);
    return row;
  }

  private fontFamilyRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "settings-inline-control settings-font-family";
    const label = document.createElement("label");
    label.textContent = "Font family";
    const select = document.createElement("select");
    for (const family of CODE_FONT_FAMILIES) {
      const option = document.createElement("option");
      option.value = family;
      option.textContent = family || "System default";
      select.appendChild(option);
    }
    select.value = this.preferences.fontFamily;
    select.addEventListener("change", () => {
      this.preferences.fontFamily = select.value as CodeFontFamily;
      this.notify();
    });
    row.append(label, select);
    return row;
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
          this.cancelRecording();
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
