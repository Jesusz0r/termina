import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  DEFAULT_SHORTCUTS,
  defaultAppPreferences,
  type AppPreferences,
  type ShortcutCommand,
  type ShortcutMap,
} from "../shared/types.js";

const MAX_PREFERENCES_BYTES = 128 * 1024;
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

export function normalizeAppPreferences(raw: unknown): AppPreferences {
  const defaults = defaultAppPreferences();
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const fontSize = input.editorFontSize;
  return {
    theme: input.theme === "light" || input.theme === "high-contrast" ? input.theme : defaults.theme,
    editorFontSize: typeof fontSize === "number" && Number.isFinite(fontSize)
      ? Math.min(20, Math.max(10, Math.round(fontSize)))
      : defaults.editorFontSize,
    minimap: typeof input.minimap === "boolean" ? input.minimap : defaults.minimap,
    shortcuts: sanitizeShortcutMap(input.shortcuts, defaults.shortcuts),
  };
}

export class AppPreferencesStore {
  private pendingWrites: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppPreferences> {
    try {
      const info = await stat(this.filePath);
      if (!info.isFile() || info.size > MAX_PREFERENCES_BYTES) return defaultAppPreferences();
      const raw = await readFile(this.filePath, "utf8");
      return normalizeAppPreferences(JSON.parse(raw));
    } catch {
      return defaultAppPreferences();
    }
  }

  save(preferences: AppPreferences): Promise<void> {
    const content = JSON.stringify(normalizeAppPreferences(preferences));
    const write = this.pendingWrites.then(() => this.write(content));
    this.pendingWrites = write.catch(() => {});
    return write;
  }

  async flush(): Promise<void> {
    await this.pendingWrites;
  }

  private async write(content: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.filePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
