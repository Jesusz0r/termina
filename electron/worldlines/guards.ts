/**
 * Small pure guards shared across the worldline owner.
 */
import { isErrno } from "../../shared/guards.js";

export function parseStorageSeq(value: string | null | undefined): number | null {
  if (value == null || value.length === 0) return null;
  // Decimal digits only: Number() would also accept hex, exponents, and
  // surrounding whitespace, and $ anchors would miss a trailing newline.
  for (const ch of value) {
    if (ch < "0" || ch > "9") return null;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** Missing/unparseable addresses always fail. Only a prompt parent may name
 * the explicit empty-session root; actual entries must remain positive. */
export function requireStorageSeq(value: string | null | undefined, message: string, opts?: { allowRoot: boolean }): number {
  const seq = parseStorageSeq(value);
  if (seq === null || (seq === 0 && !opts?.allowRoot)) throw new Error(message);
  return seq;
}

/** Native requireMissing collision: Node EEXIST, not a core error string. */
export function isComparisonDirectoryCollision(error: unknown): boolean {
  return isErrno(error, "EEXIST");
}

export function isInside(parent: string, child: string): boolean {
  // Within-or-equal (unlike main's strict pathInside): a root-level file's
  // parent IS the root, so equality must hold. A trailing slash on the
  // parent does not escape the comparison.
  const normParent = parent.length > 1 ? parent.replace(/\/+$/, "") : parent;
  if (child === parent || child === normParent) return true;
  if (normParent === "/") return child.startsWith("/");
  const rel = child.startsWith(normParent) ? child.slice(normParent.length) : null;
  return rel !== null && rel.startsWith("/");
}
