/**
 * Frozen deterministic front matter: the built-once system prompt (identity,
 * environment, instructions, skill index) plus the allow-set it discovers.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatSkillIndex as formatCompactSkillIndex } from "../skill-index.ts";
import { formatEnvironment } from "./env.ts";
import { freezeCwd, underRoot } from "./files.ts";
import {
  SKILL_XML_CAP,
  formatProjectInstructions,
  formatUserInstructions,
  scanSkills,
} from "./skills.ts";

function readOptional(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Zone 1 identity. Do not ask in chat to edit ordinary project files.
 *  Host notes that name a file not to touch (Mine, sibling claims) still bind. */
export const FROZEN_IDENTITY = [
  "You are the Termina agent-core. Be terse. Use tools to do real work in the user's project.",
  "For clear, reversible local work, do it in the current turn instead of asking permission conversationally. Follow an explicit host instruction not to touch a file. Prefer edit on existing files and grep/glob over bash search.",
  "Whenever multiple independent operations are needed, invoke all relevant tools in one turn rather than sequentially. Batch observational calls (read_file, grep, glob, fetch). Only wait when the next path is unknown without a result.",
  "Have unique current text before edit (from this turn's grep/overlay or a prior read). Copy old_text without the N| prefix. On an edit miss, use the nearby lines in the error; do not re-read unless those lines are not enough. Do not re-read a file you already have. New files use write_file in the same turn you decide to create them.",
  "When checks are required, chain them in one bash. Host diagnostics are from the previous settle; after this turn changes files, run the checks that cover those edits.",
].join("\n");

/** Built once per process, fixed order: identity, environment, user
 *  instructions, skill index, project instructions. */
export function buildFrozenSystem(opts: {
  cwd: string;
  userAgentsPath: string | null;
  userSkillDir: string | null;
  probes?: boolean;
}): { system: string; allow: Set<string> } {
  const root = freezeCwd(opts.cwd);
  const skillDirs: string[] = [];
  if (opts.userSkillDir) skillDirs.push(opts.userSkillDir);
  const projectSkillRoot = join(root, ".agents", "skills");
  try {
    if (existsSync(projectSkillRoot) && underRoot(realpathSync(projectSkillRoot), root)) {
      skillDirs.push(projectSkillRoot);
    }
  } catch {
    /* omit escaped project skill root */
  }
  const scanned = scanSkills(skillDirs);
  const allow = new Set(scanned.skills.map((s) => s.abs));
  if (opts.userAgentsPath) {
    try {
      if (existsSync(opts.userAgentsPath)) allow.add(realpathSync(opts.userAgentsPath));
    } catch {
      /* missing or unreadable */
    }
  }
  const parts = [
    FROZEN_IDENTITY,
    formatEnvironment(root, { probes: opts.probes !== false }),
  ];
  if (opts.userAgentsPath) {
    const userMd = readOptional(opts.userAgentsPath);
    if (userMd !== null) {
      let abs = opts.userAgentsPath;
      try {
        abs = realpathSync(opts.userAgentsPath);
      } catch {
        /* keep unresolved path */
      }
      parts.push(formatUserInstructions(userMd, abs));
    }
  }
  const skillXml = formatCompactSkillIndex(scanned.skills, {
    roots: skillDirs,
    capBytes: SKILL_XML_CAP,
    capped: scanned.capped,
  });
  if (skillXml) parts.push(skillXml);
  const projPath = join(root, "AGENTS.md");
  try {
    if (existsSync(projPath) && underRoot(realpathSync(projPath), root)) {
      const proj = readOptional(projPath);
      if (proj !== null) parts.push(formatProjectInstructions(proj));
    }
  } catch {
    /* omit escaped project instructions */
  }
  return { system: parts.join("\n\n"), allow };
}

export interface FrontMatter {
  systemPrompt: () => string;
  readonly allowPaths: Set<string>;
}

export function createFrontMatter(opts: { canonicalCwd: string }): FrontMatter {
  let frozenSystem: string | null = null;
  let allowPaths = new Set<string>();
  function freezeFrontMatter(): string {
    if (frozenSystem !== null) return frozenSystem;
    const built = buildFrozenSystem({
      cwd: opts.canonicalCwd,
      userAgentsPath: join(homedir(), ".agents", "AGENTS.md"),
      userSkillDir: join(homedir(), ".agents", "skills"),
      probes: true,
    });
    allowPaths = built.allow;
    frozenSystem = built.system;
    return frozenSystem;
  }
  return {
    systemPrompt: () => freezeFrontMatter(),
    get allowPaths() {
      return allowPaths;
    },
  };
}
