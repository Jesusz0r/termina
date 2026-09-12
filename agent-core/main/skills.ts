/**
 * Skills and instruction blocks: SKILL.md discovery, the skill index page,
 * and the project/user AGENTS.md wrappers. Stateless between calls.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatSkillIndex as formatCompactSkillIndex, type SkillIndexSkill } from "../skill-index.ts";
import { GREP_VISIT_CAP, classifyWalkPath, fileHasNul, sortUtf8 } from "./files.ts";

export type Skill = SkillIndexSkill;

const USER_AGENTS_CAP = 8_192;
const PROJECT_AGENTS_CAP = 24_576;
export const SKILL_XML_CAP = 8_192;

function parseFrontmatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const rest = text.startsWith("---\n") || text.startsWith("---\r\n") ? text.slice(text.indexOf("\n") + 1) : text.slice(3);
  const end = rest.search(/\n---(?:\n|$)/);
  if (end < 0) return {};
  const block = rest.slice(0, end);
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
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
      let text: string;
      try {
        const fd = openSync(abs, "r");
        try {
          const buf = Buffer.alloc(8192);
          const n = readSync(fd, buf, 0, 8192, 0);
          text = buf.subarray(0, n).toString("utf8");
        } finally {
          closeSync(fd);
        }
      } catch {
        continue;
      }
      const fm = parseFrontmatter(text);
      if (fm["disable-model-invocation"] === "true") continue;
      const name = (fm.name || basename(dirname(abs))).trim();
      if (!name) continue;
      byName.set(name, { name, description: fm.description ?? "", abs });
    }
  }
  const skills = [...byName.values()].sort((a, b) => {
    const n = Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8"));
    if (n !== 0) return n;
    return Buffer.compare(Buffer.from(a.abs, "utf8"), Buffer.from(b.abs, "utf8"));
  });
  return { skills, capped };
}

export function formatSkillIndex(skills: Skill[], opts?: { capped?: boolean }): string {
  return formatCompactSkillIndex(skills, { capBytes: SKILL_XML_CAP, capped: opts?.capped });
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
