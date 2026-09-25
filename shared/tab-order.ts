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

/**
 * Live terminal list order. Projects follow the project strip. Within a
 * project, ids follow that project's terminal strip. Anything not in those
 * strips keeps its relative creation order after the ranked entries.
 */
export function orderByStrip<T extends { id: string; projectId?: string | null }>(
  terminals: readonly T[],
  projects: readonly { id: string; terminalIds: readonly string[] }[],
): T[] {
  const projectIndex = new Map(projects.map((project, index) => [project.id, index]));
  const terminalIndex = new Map<string, number>();
  for (const project of projects) {
    for (let i = 0; i < project.terminalIds.length; i++) terminalIndex.set(project.terminalIds[i]!, i);
  }
  const last = Number.MAX_SAFE_INTEGER;
  return terminals
    .map((terminal, index) => ({ terminal, index }))
    .sort((a, b) => {
      const aProject = a.terminal.projectId != null ? projectIndex.get(a.terminal.projectId) ?? last : last;
      const bProject = b.terminal.projectId != null ? projectIndex.get(b.terminal.projectId) ?? last : last;
      if (aProject !== bProject) return aProject - bProject;
      const aTerm = terminalIndex.get(a.terminal.id) ?? last;
      const bTerm = terminalIndex.get(b.terminal.id) ?? last;
      if (aTerm !== bTerm) return aTerm - bTerm;
      return a.index - b.index;
    })
    .map(({ terminal }) => terminal);
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
