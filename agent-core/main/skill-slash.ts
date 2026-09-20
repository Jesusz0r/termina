/**
 * `/skills` slash rewrite: the engine submits a turn that asks the model
 * to read the selected SKILL.md. Skill bodies stay on disk. Not zone-1 identity.
 */
import type { SkillIndexSkill } from "../skill-index.ts";

export type SkillSlashCommand =
  | { list: true }
  | { skill: SkillIndexSkill; request: string }
  | { error: string };

const UNKNOWN_SKILL_CHARS = 80;

function unknownSkillLabel(rest: string): string {
  const clean = rest.replace(/\s+/g, " ").trim();
  if (clean.length <= UNKNOWN_SKILL_CHARS) return clean;
  return `${clean.slice(0, UNKNOWN_SKILL_CHARS - 1).trimEnd()}…`;
}

/** Parse `/skills` / `/skills <name>` / `/skills <name> <request>`. */
export function parseSkillCommand(
  line: string,
  skills: readonly SkillIndexSkill[],
): SkillSlashCommand | null {
  if (line !== "/skills" && !line.startsWith("/skills ")) return null;
  const rest = line.slice("/skills".length).trim();
  if (!rest) return { list: true };
  const lower = rest.toLowerCase();
  let best: SkillIndexSkill | null = null;
  for (const skill of skills) {
    const name = skill.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (lower === key || lower.startsWith(`${key} `)) {
      if (!best || name.length > best.name.trim().length) best = skill;
    }
  }
  if (!best) return { error: `unknown skill: ${unknownSkillLabel(rest)} — type /skills` };
  const matched = best.name.trim();
  return { skill: best, request: rest.slice(matched.length).trim() };
}

/** Rewrite a selected skill into the user message to submit. */
export function skillSlashSubmit(skill: SkillIndexSkill, request = ""): string {
  const name = skill.name.replace(/[\r\n]/g, " ").trim();
  const abs = skill.abs.replace(/[\r\n]/g, "");
  const instruction = `Read the skill ${name} with read_file at the following path and follow it for this turn. Apply it within its scope.\n${abs}`;
  const extra = request.trim();
  if (!extra) return instruction;
  return `${instruction}\n\nRequest:\n${extra}`;
}
