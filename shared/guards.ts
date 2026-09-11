/**
 * One owner for the unknown-value inspectors used across agent-core, electron
 * and shared. Deliberately dependency-free so any area (including the renderer,
 * which must never touch node:fs) can import it.
 */

/** True for a plain JSON-style object; arrays and scalars are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The `code` of a Node-style error, or null when it has none. */
export function errorCode(error: unknown): string | null {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

/** True when the value is a Node-style error carrying exactly `code`. */
export function isErrno(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === code);
}
