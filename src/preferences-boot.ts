import { normalizeAppPreferences } from "../shared/preferences";
import type { AppPreferences } from "../shared/types";

/** One initial read plus two retries. Short enough not to stall splash. */
export const PREFS_BOOT_ATTEMPTS = 3;
export const PREFS_BOOT_RETRY_DELAY_MS = 150;

export type PrefsBootResult =
  | { ok: true; preferences: AppPreferences }
  | { ok: false; error: string };

export interface LoadPreferencesOptions {
  attempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function prefsBootErrorMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "could not load settings";
}

/**
 * Bounded getPreferences retry. Failure is not a defaults baseline — the
 * caller must keep settings read-only / bannered until a later success.
 */
export async function loadPreferencesWithRetry(
  getPreferences: () => Promise<unknown>,
  options: LoadPreferencesOptions = {},
): Promise<PrefsBootResult> {
  const attempts = options.attempts ?? PREFS_BOOT_ATTEMPTS;
  const delayMs = options.delayMs ?? PREFS_BOOT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;
  let lastError = "could not load settings";
  for (let i = 0; i < attempts; i++) {
    try {
      return { ok: true, preferences: normalizeAppPreferences(await getPreferences()) };
    } catch (err) {
      lastError = prefsBootErrorMessage(err);
      if (i + 1 < attempts) await sleep(delayMs);
    }
  }
  return { ok: false, error: lastError };
}
