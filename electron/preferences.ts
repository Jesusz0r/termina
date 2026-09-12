import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { syncParentDir } from "../shared/fsync.js";
import { isErrno, isRecord } from "../shared/guards.js";
import { normalizeAppPreferences } from "../shared/preferences.js";
import { defaultAppPreferences, type AppPreferences } from "../shared/types.js";

const MAX_PREFERENCES_BYTES = 128 * 1024;

export class AppPreferencesStore {
  private pendingWrites: Promise<void> = Promise.resolve();
  /** Set when the on-disk file exists but is unreadable. Missing files are not this. */
  private resetRequired = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppPreferences> {
    this.resetRequired = false;
    try {
      const info = await stat(this.filePath);
      if (!info.isFile() || info.size > MAX_PREFERENCES_BYTES) {
        this.resetRequired = true;
        return defaultAppPreferences();
      }
      const parsed: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!isRecord(parsed)) {
        this.resetRequired = true;
        return defaultAppPreferences();
      }
      return normalizeAppPreferences(parsed);
    } catch (err) {
      if (isErrno(err, "ENOENT")) return defaultAppPreferences();
      this.resetRequired = true;
      return defaultAppPreferences();
    }
  }

  save(preferences: AppPreferences, options?: { confirmReset?: boolean }): Promise<void> {
    const content = JSON.stringify(normalizeAppPreferences(preferences));
    const confirmReset = options?.confirmReset === true;
    const write = this.pendingWrites.then(async () => {
      if (this.resetRequired && !confirmReset) {
        throw new Error("preferences file is unreadable — refusing to overwrite until reset is confirmed");
      }
      await this.write(content);
      this.resetRequired = false;
    });
    this.pendingWrites = write.catch((err) => {
      console.warn(`[preferences] write failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return write;
  }

  async flush(): Promise<void> {
    await this.pendingWrites;
  }

  private async write(content: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp-${randomUUID()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.filePath);
      syncParentDir(this.filePath);
    } catch (error) {
      try {
        await handle?.close();
      } catch {
        /* best-effort fd cleanup */
      }
      await rm(temporary, { force: true }).catch((err) => {
        console.warn(`[preferences] could not remove temp file: ${err instanceof Error ? err.message : String(err)}`);
      });
      throw error;
    }
  }
}
