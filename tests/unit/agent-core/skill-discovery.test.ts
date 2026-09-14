import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildFrozenSystem } from "../../../agent-core/main/front-matter.ts";
import { scanSkills } from "../../../agent-core/main/skills.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function skillRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "termina-skill-discovery-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const dir = join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content);
  }
  return join(root, "skills");
}

const LF_ENABLED = '---\nname: lf-skill\ndescription: lf description\n---\n# LF\n';
const CRLF_ENABLED = '---\r\nname: crlf-skill\r\ndescription: crlf description\r\n---\r\n# CRLF\r\n';
const LF_DISABLED = '---\nname: lf-off\ndisable-model-invocation: true\n---\n# off\n';
const CRLF_DISABLED = '---\r\nname: crlf-off\r\ndisable-model-invocation: true\r\n---\r\n# off\r\n';

describe("skill discovery line endings (#153)", () => {
  it("discovers LF and CRLF skills with explicit names", () => {
    const dir = skillRoot({ lf: LF_ENABLED, crlf: CRLF_ENABLED });
    const { skills } = scanSkills([dir]);
    expect(skills.map((s) => s.name).sort()).toEqual(["crlf-skill", "lf-skill"]);
    expect(skills.find((s) => s.name === "crlf-skill")?.description).toBe("crlf description");
    expect(skills.find((s) => s.name === "lf-skill")?.description).toBe("lf description");
  });

  it("honors disable-model-invocation for LF and CRLF", () => {
    const dir = skillRoot({ lfon: LF_ENABLED, lfoff: LF_DISABLED, crlfon: CRLF_ENABLED, crlfoff: CRLF_DISABLED });
    const { skills } = scanSkills([dir]);
    expect(skills.map((s) => s.name).sort()).toEqual(["crlf-skill", "lf-skill"]);
  });

  it("falls back to the directory name without explicit metadata", () => {
    const dir = skillRoot({ plain: "# no front matter\n" });
    const { skills } = scanSkills([dir]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "plain", description: "" });
  });

  it("handles EOF closing delimiters in both line endings", () => {
    const dir = skillRoot({
      lfeof: '---\nname: lf-eof\ndescription: eof\n---',
      crlfeof: '---\r\nname: crlf-eof\r\ndescription: eof\r\n---',
      crlfnl: '---\r\nname: crlf-nl\r\n---\r\nbody\r\n',
    });
    const { skills } = scanSkills([dir]);
    expect(skills.map((s) => s.name).sort()).toEqual(["crlf-eof", "crlf-nl", "lf-eof"]);
  });

  it("treats malformed headers as absent metadata, not as disabled", () => {
    const dir = skillRoot({
      unclosed: '---\nname: nope\ndescription: missing closer\n',
      notmatter: '--- not a delimiter ---\nname: nope\n',
    });
    const { skills } = scanSkills([dir]);
    expect(skills.map((s) => s.name).sort()).toEqual(["notmatter", "unclosed"]);
    expect(skills.every((s) => s.description === "")).toBe(true);
  });

  it("builds the allow-set and index from discovered skills only", () => {
    const root = mkdtempSync(join(tmpdir(), "termina-skill-frozen-"));
    roots.push(root);
    const skillsDir = join(root, ".agents", "skills");
    for (const [name, content] of Object.entries({ on: CRLF_ENABLED, off: CRLF_DISABLED })) {
      const dir = join(skillsDir, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), content);
    }
    const built = buildFrozenSystem({ cwd: root, userAgentsPath: null, userSkillDir: null, probes: false });
    expect(built.system).toContain("crlf-skill");
    expect(built.system).not.toContain("crlf-off");
    expect([...built.allow].some((p) => p.endsWith(join("on", "SKILL.md")))).toBe(true);
    expect([...built.allow].some((p) => p.endsWith(join("off", "SKILL.md")))).toBe(false);
  });
});
