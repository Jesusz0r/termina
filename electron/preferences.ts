import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultAppPreferences, type AppPreferences } from "../shared/types.js";
import { normalizeAppPreferences } from "../shared/preferences.js";

export { normalizeAppPreferences, sanitizeShortcutMap } from "../shared/preferences.js";

const MAX_PREFERENCES_BYTES = 128 * 1024;

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
