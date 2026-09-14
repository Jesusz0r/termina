/**
 * Shared env-int parsing for perf-baseline and perf-compare (issue #261 CO/M5).
 *
 * Missing or non-positive values fall back; the parsers must not publish a
 * 0-file run from `PERF_FILES=abc`.
 */
export function perfInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = Number(env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
