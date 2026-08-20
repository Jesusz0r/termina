import { DEFAULT_SHORTCUTS, type ShortcutCommand, type ShortcutMap } from "../shared/types";

export const SHORTCUTS: Array<{ command: ShortcutCommand; label: string; description: string }> = [
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
  { command: "layout-terminal-left", label: "Terminal left", description: "Place the terminal on the left" },
  { command: "layout-terminal-right", label: "Terminal right", description: "Place the terminal on the right" },
  { command: "layout-terminal-top", label: "Terminal top", description: "Place the terminal on the top" },
  { command: "layout-terminal-bottom", label: "Terminal bottom", description: "Place the terminal on the bottom" },
  { command: "toggle-explorer", label: "Toggle explorer", description: "Minimize or restore the file explorer" },
  { command: "toggle-terminal", label: "Toggle terminal", description: "Minimize or restore the terminal" },
  { command: "toggle-editor", label: "Toggle editor", description: "Minimize or restore the editor" },
  { command: "toggle-modified", label: "Toggle modified panel", description: "Show or hide changed files" },
  { command: "session-search", label: "Search sessions", description: "Search previous Pi sessions" },
  { command: "open-settings", label: "Open settings", description: "Open this preferences window" },
];

export function emptyShortcuts(): ShortcutMap {
  const result = { ...DEFAULT_SHORTCUTS };
  for (const command of Object.keys(result) as ShortcutCommand[]) result[command] = "";
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
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  const keys: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    NumpadEnter: "Enter",
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

export function shortcutForEvent(event: KeyboardEvent): string | null {
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
