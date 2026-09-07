/**
 * Small pure guards shared across the worldline owner.
 */
export function parseStorageSeq(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function isInside(parent: string, child: string): boolean {
  const rel = child.startsWith(parent) ? child.slice(parent.length) : null;
  return rel !== null && (rel.startsWith("/") || rel === "");
}

/**
 * Extract the errno code from an unknown caught value, or null.
 */
export function errnoCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
