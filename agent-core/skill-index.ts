/**
 * Compact, deterministic skill discovery for the frozen system prompt.
 *
 * Skill bodies stay on disk and are read on demand.  The index therefore
 * carries every eligible name and a deterministic path, while descriptions
 * are only included when the complete index fits the byte budget.  The
 * caller's allow set remains the authority for reads; this module only
 * formats model-visible discovery data.
 */

import { Buffer } from "node:buffer";

export type SkillIndexSkill = {
  name: string;
  description: string;
  abs: string;
};

export type SkillIndexOptions = {
  /** Root directories used during discovery, in any order. */
  roots?: readonly string[];
  /** Maximum UTF-8 bytes for the complete rendered index. */
  capBytes?: number;
  /** Whether the underlying filesystem walk hit its visit cap. */
  capped?: boolean;
  /** Maximum characters for a compact trigger hint. */
  maxTriggerChars?: number;
};

export const DEFAULT_SKILL_INDEX_BYTES = 8 * 1024;
/** Enough of the trigger to distinguish a skill while keeping all entries. */
export const DEFAULT_SKILL_TRIGGER_CHARS = 24;

const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const SLASH_RE = /\\/g;
const SKILL_FILE = "/SKILL.md";

function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function stripControls(value: string): string {
  return value.replace(CONTROL_RE, "");
}

/** Escape text used in XML attributes or element content. */
export function skillIndexXmlSafe(value: string): string {
  return stripControls(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function slashPath(value: string): string {
  return value.replace(SLASH_RE, "/");
}

function normalizedRoot(value: string): string {
  const root = slashPath(value.trim());
  if (root.length <= 1) return root;
  return root.replace(/\/+$/g, "");
}

function pathWithin(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(`${root}/`);
}

function fallbackRoot(abs: string): string {
  const path = slashPath(abs);
  const skillFile = path.endsWith(SKILL_FILE) ? path.slice(0, -SKILL_FILE.length) : path;
  const slash = skillFile.lastIndexOf("/");
  return slash > 0 ? skillFile.slice(0, slash) : ".";
}

function relativeSkillPath(root: string, abs: string): string {
  if (!pathWithin(root, abs)) return abs;
  const relative = abs.slice(root.length).replace(/^\/+/, "");
  return relative || "SKILL.md";
}

function safeLayoutName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !/[\\/\r\n]/.test(name);
}

function compactTrigger(description: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  const clean = stripControls(description).replace(/\s+/g, " ").trim();
  if (!clean) return "";

  // A first sentence keeps the trigger useful without copying the long list
  // of examples that many front matters contain.
  const sentence = clean.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? clean;
  if (sentence.length <= maxChars) return sentence;
  const room = Math.max(1, maxChars - 1);
  return `${sentence.slice(0, room).trimEnd()}…`;
}

type SkillEntry = {
  name: string;
  description: string;
  abs: string;
  root: string;
  relativePath: string;
  standardPath: boolean;
};

type SkillRoot = {
  path: string;
  entries: SkillEntry[];
};

function rootsFor(roots: readonly string[]): string[] {
  const supplied = roots
    .map((root) => normalizedRoot(String(root)))
    .filter(Boolean);
  return [...new Set(supplied)].sort(utf8Compare);
}

function entryFor(skill: SkillIndexSkill, roots: readonly string[]): SkillEntry {
  const name = typeof skill.name === "string" ? skill.name : String(skill.name ?? "");
  const description = typeof skill.description === "string" ? skill.description : String(skill.description ?? "");
  const abs = slashPath(typeof skill.abs === "string" ? skill.abs : String(skill.abs ?? ""));
  const matchingRoots = roots
    .filter((root) => pathWithin(root, abs))
    .sort((a, b) => b.length - a.length || utf8Compare(a, b));
  const root = matchingRoots[0] ?? fallbackRoot(abs);
  const relativePath = relativeSkillPath(root, abs);
  return {
    name,
    description,
    abs,
    root,
    relativePath,
    standardPath: safeLayoutName(name) && relativePath === `${name}/SKILL.md`,
  };
}

function groupedSkills(skills: readonly SkillIndexSkill[], roots: readonly string[]): SkillRoot[] {
  const groups = new Map<string, SkillEntry[]>();
  for (const raw of skills) {
    const entry = entryFor(raw, roots);
    const group = groups.get(entry.root);
    if (group) group.push(entry);
    else groups.set(entry.root, [entry]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => utf8Compare(a, b))
    .map(([path, entries]) => ({
      path,
      entries: entries.sort((a, b) =>
        utf8Compare(a.name, b.name) ||
        utf8Compare(a.relativePath, b.relativePath) ||
        utf8Compare(a.abs, b.abs) ||
        utf8Compare(a.description, b.description),
      ),
    }));
}

function lineSafe(value: string): string {
  return skillIndexXmlSafe(value).replace(/[\r\n\t]+/g, " ");
}

function renderLineRoots(
  groups: readonly SkillRoot[],
  maxTriggerChars: number,
  includeInstruction: boolean,
  capped: boolean,
): string {
  const lines: string[] = ["<skill-index>"];
  if (includeInstruction) {
    lines.push("Read skills by joining root with name/SKILL.md. Standard lines use name [TAB] trigger; nested lines use name [TAB] relative path [TAB] trigger.");
  }
  for (const group of groups) {
    lines.push(
      `<skill-root path="${skillIndexXmlSafe(group.path)}" layout="{name}/SKILL.md" format="standard name, trigger; nested name, path, trigger; fields separated by TAB">`,
    );
    for (const entry of group.entries) {
      const fields = [lineSafe(entry.name)];
      if (!entry.standardPath) fields.push(lineSafe(entry.relativePath));
      const trigger = compactTrigger(entry.description, maxTriggerChars);
      if (trigger) fields.push(lineSafe(trigger));
      lines.push(fields.join("\t"));
    }
    lines.push("</skill-root>");
  }
  if (capped) lines.push("<!-- skill scan capped -->");
  lines.push("</skill-index>");
  return lines.join("\n");
}

function renderCompactRoots(groups: readonly SkillRoot[], includeInstruction: boolean, capped: boolean): string {
  return renderLineRoots(groups, 0, includeInstruction, capped);
}

function capBytes(value: unknown): number {
  if (!Number.isFinite(value)) return DEFAULT_SKILL_INDEX_BYTES;
  return Math.max(0, Math.floor(Number(value)));
}

function largestFittingTriggerIndex(
  groups: readonly SkillRoot[],
  maxTriggerChars: number,
  capped: boolean,
  maxBytes: number,
): string | null {
  let low = 0;
  let high = maxTriggerChars;
  let best = -1;
  while (low <= high) {
    const candidateChars = Math.floor((low + high) / 2);
    const candidate = renderLineRoots(groups, candidateChars, true, capped);
    if (utf8Bytes(candidate) <= maxBytes) {
      best = candidateChars;
      low = candidateChars + 1;
    } else {
      high = candidateChars - 1;
    }
  }
  if (best < 0) return null;
  return renderLineRoots(groups, best, true, capped);
}

/**
 * Render all discovered skills under a strict UTF-8 byte cap.
 *
 * The formatter first tries short trigger hints, then drops only those hints,
 * and finally switches to a line-oriented root listing.  It never applies a
 * relevance guess or silently drops a skill while a compact representation
 * can still fit.  An impossible cap returns a minimal closed index rather
 * than malformed XML or an over-budget prompt.
 */
export function formatSkillIndex(
  skills: readonly SkillIndexSkill[],
  opts: SkillIndexOptions = {},
): string {
  const maxBytes = capBytes(opts.capBytes);
  if (maxBytes === 0) return "";
  const groups = groupedSkills(skills, rootsFor(opts.roots ?? []));
  if (groups.length === 0 && !opts.capped) return "";
  const maxTriggerChars = Number.isFinite(opts.maxTriggerChars)
    ? Math.max(0, Math.floor(Number(opts.maxTriggerChars)))
    : DEFAULT_SKILL_TRIGGER_CHARS;

  const withTriggers = largestFittingTriggerIndex(groups, maxTriggerChars, Boolean(opts.capped), maxBytes);
  const candidates = [
    ...(withTriggers ? [withTriggers] : []),
    renderCompactRoots(groups, true, Boolean(opts.capped)),
    renderCompactRoots(groups, false, Boolean(opts.capped)),
  ];
  for (const candidate of candidates) {
    if (utf8Bytes(candidate) <= maxBytes) return candidate;
  }

  const minimal = "<skill-index/>";
  return utf8Bytes(minimal) <= maxBytes ? minimal : "";
}
