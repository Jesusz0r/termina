import {
  CODE_FONT_FAMILIES,
  DEFAULT_SHORTCUTS,
  THEME_IDS,
  defaultAppPreferences,
  type AppPreferences,
  type CodeFontFamily,
  type ShortcutCommand,
  type ShortcutMap,
  type ThemeId,
  type UserPreferencePatch,
} from "./types";

const MAX_SHORTCUT_LENGTH = 64;
const SHORTCUT_MODIFIERS = new Set(["CmdOrCtrl", "Command", "Ctrl", "Alt", "Shift", "Super"]);
const SHORTCUT_SPECIAL_KEYS = new Set([
  "Enter",
  "Escape",
  "Space",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Up",
  "Down",
  "Left",
  "Right",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
  "`",
]);

function isValidShortcut(value: string): boolean {
  if (!value) return true;
  const parts = value.split("+");
  const key = parts.pop() ?? "";
  if (parts.some((part) => !SHORTCUT_MODIFIERS.has(part)) || new Set(parts).size !== parts.length) return false;
  return /^[A-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-2])$/.test(key) || SHORTCUT_SPECIAL_KEYS.has(key);
}

export function sanitizeShortcutMap(raw: unknown, fallback: ShortcutMap = DEFAULT_SHORTCUTS): ShortcutMap {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const result = {} as ShortcutMap;
  const used = new Set<string>();
  for (const command of Object.keys(DEFAULT_SHORTCUTS) as ShortcutCommand[]) {
    const fallbackValue = typeof fallback[command] === "string" ? fallback[command] : "";
    const candidate = typeof input[command] === "string" ? input[command].trim() : fallbackValue;
    if (candidate.length > MAX_SHORTCUT_LENGTH || !isValidShortcut(candidate) || (candidate !== "" && used.has(candidate))) {
      result[command] = "";
      continue;
    }
    result[command] = candidate;
    if (candidate) used.add(candidate);
  }
  return result;
}

function clampFontSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(20, Math.max(10, Math.round(value)));
}

function sanitizeFontFamily(value: unknown, fallback: CodeFontFamily): CodeFontFamily {
  return CODE_FONT_FAMILIES.includes(value as CodeFontFamily) ? value as CodeFontFamily : fallback;
}

const MAX_OPEN_PROJECTS = 12;

/** Canonical roots of the projects to reopen on launch. Main owns writes;
 *  validation still guards the file against a hand-edited entry. */
function sanitizeOpenProjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 1024) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
    if (result.length >= MAX_OPEN_PROJECTS) break;
  }
  return result;
}

export function normalizeAppPreferences(raw: unknown): AppPreferences {
  const defaults = defaultAppPreferences();
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return {
    theme: THEME_IDS.includes(input.theme as ThemeId) ? input.theme as ThemeId : defaults.theme,
    editorFontSize: clampFontSize(input.editorFontSize, defaults.editorFontSize),
    terminalFontSize: clampFontSize(input.terminalFontSize, defaults.terminalFontSize),
    fontFamily: sanitizeFontFamily(input.fontFamily, defaults.fontFamily),
    wordWrap: typeof input.wordWrap === "boolean" ? input.wordWrap : defaults.wordWrap,
    minimap: typeof input.minimap === "boolean" ? input.minimap : defaults.minimap,
    shortcuts: sanitizeShortcutMap(input.shortcuts, defaults.shortcuts),
    openProjects: sanitizeOpenProjects(input.openProjects),
    showThinking: typeof input.showThinking === "boolean" ? input.showThinking : defaults.showThinking,
  };
}

const USER_PATCH_KEYS = [
  "theme",
  "editorFontSize",
  "terminalFontSize",
  "fontFamily",
  "wordWrap",
  "minimap",
  "shortcuts",
  "showThinking",
] as const satisfies ReadonlyArray<keyof UserPreferencePatch>;

export function normalizeUserPreferencePatch(raw: unknown): UserPreferencePatch {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const full = normalizeAppPreferences(input);
  const patch: UserPreferencePatch = {};
  for (const key of USER_PATCH_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      (patch as Record<string, unknown>)[key] = full[key];
    }
  }
  return patch;
}
