/**
 * Tab-strip order shared by the renderer drop and the main-process stores.
 * A reorder is accepted only when it is the same set of ids.
 */

/** The requested order, or null when it is not a permutation of `current`. */
export function reorderPermutation(current: readonly string[], requested: readonly string[]): string[] | null {
  if (requested.length !== current.length) return null;
  const seen = new Set<string>();
  for (const id of requested) {
    if (seen.has(id)) return null;
    seen.add(id);
  }
  if (seen.size !== current.length) return null;
  for (const id of current) {
    if (!seen.has(id)) return null;
  }
  return [...requested];
}

/** Index in `slots` where a pointer at `clientX` should land. `slots.length` means after the last. */
export function insertionIndex(clientX: number, slots: readonly { left: number; width: number }[]): number {
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const mid = slot.left + slot.width / 2;
    if (clientX < mid) return i;
  }
  return slots.length;
}
