import { COMMAND_DEFINITIONS, DEFAULT_SHORTCUTS, type ShortcutCommand, type ShortcutMap } from "../shared/types";

export const SHORTCUTS = COMMAND_DEFINITIONS;

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
