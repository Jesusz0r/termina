/**
 * Skills and instruction blocks: SKILL.md discovery plus the project/user
 * AGENTS.md wrappers. The skill index itself is rendered by skill-index.ts.
 * Stateless between calls.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { SkillIndexSkill } from "../skill-index.ts";
import { BoundedTextAccumulator, type ToolTextResult } from "../tool-output.ts";
import { GREP_VISIT_CAP, classifyWalkPath, confinePath, fileHasNul, freezeCwd, matchGlob, posixRel, readBoundedRegularFile, sortUtf8 } from "./files.ts";

type Skill = SkillIndexSkill;

const USER_AGENTS_CAP = 8_192;
const PROJECT_AGENTS_CAP = 24_576;
export const SKILL_XML_CAP = 8_192;
export const PATH_RULE_BYTES = 8_192;
const MAX_PATH_RULE_PATTERNS = 16;

function parseFrontmatter(text: string): { values: Record<string, string>; body: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return { values: {}, body: normalized };
  const block = match[1]!;
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return { values: out, body: normalized.slice(match[0].length) };
}

function skillPaths(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATH_RULE_PATTERNS) return undefined;
  const paths: string[] = [];
  for (const path of value) {
    if (typeof path !== "string" || path.length === 0 || path.length > 256 || isAbsolute(path)
      || /[\\\x00-\x1f\x7f\[\]{}]/.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) return undefined;
    paths.push(path);
  }
  return paths;
}

function walkSkillFiles(scanRoot: string): { files: string[]; capped: boolean } {
  if (!existsSync(scanRoot)) return { files: [], capped: false };
  let rootReal: string;
  try {
    rootReal = realpathSync(scanRoot);
  } catch {
    return { files: [], capped: false };
  }
  const found: string[] = [];
  const visited = new Set<string>();
  const stack = [rootReal];
  let visits = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let dirReal = dir;
    try {
      dirReal = realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(dirReal)) continue;
    visited.add(dirReal);
    let ents;
    try {
      ents = readdirSync(dirReal, { withFileTypes: true });
    } catch {
      continue;
    }
    const names = sortUtf8(ents.map((e) => e.name));
    for (const name of names) {
      if (name === "." || name === "..") continue;
      if (name === "node_modules") continue;
      visits++;
      if (visits > GREP_VISIT_CAP) return { files: found, capped: true };
      const abs = join(dirReal, name);
      const next = classifyWalkPath(abs, rootReal);
      if (!next) continue;
      if (next.kind === "dir") stack.push(next.real);
      else if (basename(next.real) === "SKILL.md") found.push(next.real);
    }
  }
  found.sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  return { files: found, capped: false };
}

export function scanSkills(dirs: string[]): { skills: Skill[]; capped: boolean } {
  const byName = new Map<string, Skill>();
  let capped = false;
  for (const dir of dirs) {
    const walked = walkSkillFiles(dir);
    if (walked.capped) capped = true;
    for (const abs of walked.files) {
      if (fileHasNul(abs)) continue;
      const head = readBoundedRegularFile(abs, 8192);
      if ("error" in head) continue;
      const text = head.text;
      const fm = parseFrontmatter(text).values;
      if (fm["disable-model-invocation"] === "true") continue;
      const name = (fm.name || basename(dirname(abs))).trim();
      if (!name) continue;
      const paths = skillPaths(fm.paths);
      byName.set(name, { name, description: fm.description ?? "", abs, ...(paths ? { paths } : {}) });
    }
  }
  const skills = [...byName.values()].sort((a, b) => {
    const n = Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8"));
    if (n !== 0) return n;
    return Buffer.compare(Buffer.from(a.abs, "utf8"), Buffer.from(b.abs, "utf8"));
  });
  return { skills, capped };
}

/** Load only indexed rules matching canonical files in this project. Never scan ancestors. */
export function attachPathRules(
  cwd: string,
  skills: readonly SkillIndexSkill[],
  paths: readonly string[],
  output: ToolTextResult,
): ToolTextResult {
  if (!skills.some(skill => skill.paths)) return output;
  const root = freezeCwd(cwd);
  const targets: string[] = [];
  for (const path of paths) {
    const target = confinePath(root, path, { mustExist: true });
    if (!target.ok) continue;
    try {
      if (statSync(target.abs).isFile()) targets.push(posixRel(root, target.abs));
    } catch { /* A vanished target cannot load a rule. */ }
  }
  if (targets.length === 0) return output;
  const rules = new BoundedTextAccumulator({ maxBytes: PATH_RULE_BYTES, marker: "[path rules truncated; read the matching SKILL.md files for the rest]" });
  let attachedBytes = 0;
  for (const skill of skills) {
    if (!skill.paths?.some(pattern => targets.some(path => matchGlob(pattern, path)))) continue;
    try {
      // A source swapped to a symlink after indexing is no longer the indexed file.
      if (realpathSync(skill.abs) !== skill.abs) continue;
    } catch { continue; }
    const got = readBoundedRegularFile(skill.abs, SKILL_XML_CAP + PATH_RULE_BYTES);
    if ("error" in got || got.text.includes("\0")) continue;
    const body = parseFrontmatter(got.text).body.trim();
    if (!body) continue;
    const section = `\n\nPath rules from ${JSON.stringify(skill.abs)} for ${JSON.stringify(skill.paths)}:\n${body}`;
    rules.push(section);
    attachedBytes += Buffer.byteLength(section, "utf8");
    if (attachedBytes > PATH_RULE_BYTES) break;
  }
  if (attachedBytes === 0) return output;
  const suffix = rules.finish();
  return Object.freeze({
    ...output,
    text: output.text + suffix.text,
    content: output.content + suffix.text,
    limitBytes: output.limitBytes + PATH_RULE_BYTES,
    inputBytes: output.inputBytes + suffix.inputBytes,
    retainedBytes: output.retainedBytes + suffix.retainedBytes,
    omittedBytes: output.omittedBytes + suffix.omittedBytes,
    outputBytes: output.outputBytes + suffix.outputBytes,
    truncated: output.truncated || suffix.truncated,
  });
}

function capParagraph(md: string, max: number): { text: string; omitted: number } {
  if (md.length <= max) return { text: md, omitted: 0 };
  const slice = md.slice(0, max);
  const blank = slice.lastIndexOf("\n\n");
  const text = blank > 0 ? slice.slice(0, blank) : slice;
  return { text, omitted: md.length - text.length };
}

export function formatProjectInstructions(md: string): string {
  const { text, omitted } = capParagraph(md, PROJECT_AGENTS_CAP);
  let body = text;
  if (omitted > 0) body += `\n<!-- AGENTS.md truncated; ${omitted} chars remain; read AGENTS.md with read_file -->`;
  return `<project-instructions>\n${body}\n</project-instructions>`;
}

export function formatUserInstructions(md: string, absPath: string): string {
  const { text, omitted } = capParagraph(md, USER_AGENTS_CAP);
  let body = text;
  if (omitted > 0) {
    // Keep the absolute path outside the HTML comment. A path that contains
    // "--" would otherwise close the comment early.
    body += `\n<!-- AGENTS.md truncated; ${omitted} chars remain -->\nread_file ${JSON.stringify(absPath)}`;
  }
  return `<user-instructions>\n${body}\n</user-instructions>`;
}
