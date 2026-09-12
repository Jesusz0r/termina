/**
 * Decision for unsaved editor buffers on tab close, project close, and quit.
 * UI and save I/O stay with their owners; this only answers what to do.
 */

export type UnsavedCloseChoice = "save" | "discard" | "cancel";
export type UnsavedCloseDecision = "save" | "proceed" | "abort";

/** No dirty buffers → proceed. Cancel/unknown → abort. Discard → proceed. Save → save. */
export function decideUnsavedClose(hasDirty: boolean, choice: UnsavedCloseChoice | null): UnsavedCloseDecision {
  if (!hasDirty) return "proceed";
  if (choice === "save") return "save";
  if (choice === "discard") return "proceed";
  return "abort";
}

/** Copy for the Save / Discard / Cancel prompt. */
export function unsavedCloseMessage(count: number, fileName?: string): string {
  if (count <= 1 && fileName) return `${fileName} has unsaved changes.`;
  if (count <= 1) return "1 file has unsaved changes.";
  return `${count} files have unsaved changes.`;
}
