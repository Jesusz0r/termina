/**
 * Explorer row state that is pure enough to test without a DOM: the icon kind
 * for a file name, the base/extension split used for two-tone names, and the
 * set of rows the agent-change marker applies to.
 *
 * Extension -> language stays owned by `editor-language.ts`; this module maps
 * that result plus a few non-code extensions onto a small visual kind, so the
 * tree never grows a second extension table.
 */

import { languageForPath } from "./editor-language";

export type FileIconKind = "code" | "config" | "doc" | "image" | "archive" | "file";

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif", "tiff"]);
const ARCHIVE_EXTS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "dmg"]);
const DOC_EXTS = new Set(["md", "mdx", "txt", "rst", "adoc", "log"]);
const CONFIG_EXTS = new Set(["json", "jsonc", "yml", "yaml", "toml", "ini", "env", "lock", "xml", "csv"]);

/** Index where the extension starts, or -1 when there is none. One owner for
 *  the rule: a leading dot is a dotfile (".env") and a trailing dot is not an
 *  extension. */
function extensionIndex(name: string): number {
  const at = name.lastIndexOf(".");
  return at <= 0 || at === name.length - 1 ? -1 : at;
}

/** Lowercase extension without the dot; "" for dotfiles and extensionless names. */
export function extensionOf(name: string): string {
  const at = extensionIndex(name);
  return at === -1 ? "" : name.slice(at + 1).toLowerCase();
}

/** Visual kind for a file row. Directories do not reach here. */
export function fileIconKind(name: string): FileIconKind {
  const ext = extensionOf(name);
  if (!ext) return "file";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (DOC_EXTS.has(ext)) return "doc";
  if (CONFIG_EXTS.has(ext)) return "config";
  return languageForPath(name) === "plaintext" ? "file" : "code";
}

/** Name split for two-tone rendering; the extension keeps its leading dot. */
export function splitExtension(name: string): { base: string; ext: string } {
  const at = extensionIndex(name);
  if (at === -1) return { base: name, ext: "" };
  return { base: name.slice(0, at), ext: name.slice(at) };
}

/** Project-relative path with forward slashes, for cross-separator comparison. */
export function normalizeRelPath(relPath: string): string {
  return relPath.split(/[\\/]/).join("/");
}

/** Path segments, dropping empties and the "." root sentinel. One owner for
 *  how a project-relative path is split. */
function relSegments(relPath: string): string[] {
  return normalizeRelPath(relPath).split("/").filter((part) => part !== "" && part !== ".");
}

/** Ancestor directories of a project-relative path, outermost first. */
export function ancestorDirs(relPath: string): string[] {
  const parts = relSegments(relPath);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * Split changed project-relative paths into the file set and the directory set
 * that must also show the marker (a collapsed folder still had a file change
 * inside it). Pure so the marking rule is testable without a DOM.
 */
export function computeChangedSets(relPaths: readonly string[]): {
  files: Set<string>;
  dirs: Set<string>;
} {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const raw of relPaths) {
    const rel = normalizeRelPath(raw);
    // "." is the project-root sentinel used elsewhere in the explorer, not a file.
    if (!rel || rel === ".") continue;
    files.add(rel);
    for (const dir of ancestorDirs(rel)) dirs.add(dir);
  }
  // The project root is a folder like any other: with the root collapsed the
  // only visible row would otherwise stay unmarked while every collapsed
  // subfolder showed the marker. "" is the root row's relative path.
  if (files.size > 0) dirs.add("");
  return { files, dirs };
}

/** The pane fields the explorer's change marks are derived from. */
export interface ChangedPaneSource {
  projectId: string | null;
  workspaceId: string;
  modified: ReadonlyArray<{ relPath: string }>;
}

/**
 * Project-relative paths the explorer should mark, from every pane that works
 * in the project's OWN workspace.
 *
 * A project owns several workspaces (the primary tree plus worldline candidate
 * and dispatch trees), and main roots each instance's `relPath` at that
 * instance's own workspace root (`workspaceOfTerminal` -> `relPath`). So
 * filtering on `projectId` alone would mark project files that a candidate
 * changed in a different tree: the same relative path names two different
 * files. `workspaceId` is what makes the mark truthful.
 */
export function projectChangedPaths(
  panes: Iterable<ChangedPaneSource>,
  projectId: string | null,
  workspaceId: string,
): string[] {
  if (!projectId) return [];
  const out = new Set<string>();
  for (const pane of panes) {
    if (pane.projectId !== projectId) continue;
    if (pane.workspaceId !== workspaceId) continue;
    for (const file of pane.modified) out.add(file.relPath);
  }
  return [...out];
}

/** 1-based tree depth for a row: the project root is level 1. Drives
 *  `aria-level` and the "is this row inside that row's subtree" check. */
export function rowLevel(relPath: string): number {
  return relSegments(relPath).length + 1;
}

/**
 * Relative path of the row that owns `relPath` in the tree: the root row ("")
 * for a top-level entry, the containing folder otherwise, and null for the root
 * itself (which has no parent row). Drives ArrowLeft.
 */
export function parentRowRel(relPath: string): string | null {
  const parts = relSegments(relPath);
  if (parts.length === 0) return null;
  if (parts.length === 1) return "";
  return parts.slice(0, -1).join("/");
}

/**
 * Folder that receives a new entry (create) or a Paste for this row. A folder
 * takes it directly; a file takes it beside itself, in its parent folder.
 * One owner for "where does an entry go relative to this row".
 */
export function targetDirRel(entry: { relPath: string; type: "file" | "dir" }): string {
  const rel = normalizeRelPath(entry.relPath);
  if (entry.type === "dir") return rel;
  const at = rel.lastIndexOf("/");
  return at === -1 ? "" : rel.slice(0, at);
}

/**
 * Confirmation text for deleting one explorer entry. A directory delete is
 * recursive (`rm -rf` in main), so the message must say so: the count cannot be
 * known here without a walk, and a stale or truncated count would understate a
 * destructive action.
 */
export function deleteConfirmMessage(entry: { relPath: string; name: string; type: "file" | "dir" }): string {
  const label = entry.relPath || entry.name;
  return entry.type === "dir"
    ? `Delete folder "${label}" and everything inside it?`
    : `Delete file "${label}"?`;
}

/**
 * Index of the next row whose name starts with `buffer`, searching forward from
 * `from` and wrapping. Returns -1 when nothing matches.
 *
 * A multi-character buffer that matches nothing falls back to its first
 * character, so typing "ss" walks the "s" entries the way VS Code does instead
 * of dead-ending on a name that does not exist.
 */
export function findTypeAheadIndex(names: readonly string[], from: number, buffer: string): number {
  const query = buffer.toLowerCase();
  if (!query || names.length === 0) return -1;
  const search = (needle: string): number => {
    for (let step = 1; step <= names.length; step++) {
      const index = (from + step) % names.length;
      const name = (names[index] ?? "").toLowerCase();
      if (name.startsWith(needle)) return index;
    }
    return -1;
  };
  const direct = search(query);
  if (direct !== -1) return direct;
  return query.length > 1 ? search(query.slice(0, 1)) : -1;
}

/**
 * Rows that survive an active filter: every match, every ancestor directory of a
 * match, and the project root.
 *
 * Ancestors are the point. A match inside a collapsed folder only reads as "in
 * context" if the path down to it stays on screen, so the set carries the whole
 * chain rather than the bare matches. The root ("") is included for the same
 * reason the change marker includes it: with the root collapsed, a filtered tree
 * would otherwise show nothing at all.
 *
 * An empty result yields an empty set, NOT null: "the query matched nothing" and
 * "no filter is active" are different states, and only the caller knows which
 * one it is. A null return here would paint a no-match query as an unfiltered
 * tree.
 */
export function filterVisibleSet(matches: readonly string[]): Set<string> {
  const visible = new Set<string>();
  for (const raw of matches) {
    const rel = normalizeRelPath(raw);
    // Blank, root-sentinel and whitespace-only entries are not real paths; a
    // bare " " would otherwise enter the set and keep the root visible, showing
    // an unfiltered-looking tree for a query that matched nothing.
    if (!rel || rel === "." || !rel.trim()) continue;
    visible.add(rel);
    for (const dir of ancestorDirs(rel)) visible.add(dir);
  }
  if (visible.size > 0) visible.add("");
  return visible;
}

/** True when a row stays visible under an active filter set. */
export function filterKeeps(visible: Set<string>, relPath: string): boolean {
  return visible.has(normalizeRelPath(relPath));
}
