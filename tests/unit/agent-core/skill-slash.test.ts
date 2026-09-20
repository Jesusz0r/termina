import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseSkillCommand, skillSlashSubmit } from "../../../agent-core/main/skill-slash.ts";
import type { SkillIndexSkill } from "../../../agent-core/skill-index.ts";

const SKILLS: SkillIndexSkill[] = [
  { name: "qa", description: "run implementation QA", abs: "/skills/qa/SKILL.md" },
  { name: "review", description: "review the diff", abs: "/skills/review/SKILL.md" },
  { name: "review notes", description: "longer name", abs: "/skills/review-notes/SKILL.md" },
];

describe("parseSkillCommand", () => {
  it("lists on a bare /skills", () => {
    expect(parseSkillCommand("/skills", SKILLS)).toEqual({ list: true });
    expect(parseSkillCommand("/skills  ", SKILLS)).toEqual({ list: true });
  });

  it("selects a skill by name and keeps the rest as the request", () => {
    expect(parseSkillCommand("/skills qa", SKILLS)).toEqual({
      skill: SKILLS[0],
      request: "",
    });
    expect(parseSkillCommand("/skills QA this site", SKILLS)).toEqual({
      skill: SKILLS[0],
      request: "this site",
    });
  });

  it("prefers the longest matching skill name", () => {
    expect(parseSkillCommand("/skills review notes extra", SKILLS)).toEqual({
      skill: SKILLS[2],
      request: "extra",
    });
    expect(parseSkillCommand("/skills review extra", SKILLS)).toEqual({
      skill: SKILLS[1],
      request: "extra",
    });
  });

  it("rejects unknown names and ignores other slash lines", () => {
    expect(parseSkillCommand("/skills nope", SKILLS)).toEqual({
      error: "unknown skill: nope — type /skills",
    });
    expect(parseSkillCommand("/plan", SKILLS)).toBeNull();
    expect(parseSkillCommand("/skill", SKILLS)).toBeNull();
    expect(parseSkillCommand("skills qa", SKILLS)).toBeNull();
    expect(parseSkillCommand("/skills nope\nand more", SKILLS)).toEqual({
      error: "unknown skill: nope and more — type /skills",
    });
    const long = `nope ${"x".repeat(120)}`;
    const error = parseSkillCommand(`/skills ${long}`, SKILLS);
    expect(error && "error" in error && error.error.length < 120).toBe(true);
    expect(error && "error" in error && !error.error.includes("x".repeat(90))).toBe(true);
  });
});

describe("skillSlashSubmit", () => {
  it("asks the model to read the selected SKILL.md", () => {
    const text = skillSlashSubmit(SKILLS[0]!);
    expect(text).toContain("qa");
    expect(text).toContain("/skills/qa/SKILL.md");
    expect(text).toContain("read_file");
    expect(text.indexOf("/skills/qa/SKILL.md")).toBeGreaterThan(text.indexOf("read_file"));
    expect(text).not.toContain("\"qa\"");
    expect(text).not.toContain("run implementation QA");
    expect(text).not.toContain("Request:");
  });

  it("appends the rest of /skills as the request", () => {
    const text = skillSlashSubmit(SKILLS[1]!, "src/auth.ts");
    expect(text).toContain("read_file");
    expect(text).toContain("Request:\nsrc/auth.ts");
  });
});

describe("engine skill dispatch", () => {
  it("rewrites /skills through the frozen skill list", () => {
    const main = readFileSync(new URL("../../../agent-core/main.ts", import.meta.url), "utf8");
    expect(main).toContain("parseSkillCommand(line, frontMatter.skills)");
    expect(main).toContain("skillSlashSubmit(skillCmd.skill, skillCmd.request)");
    expect(main).toContain("setSkillRows(skillCommandRows(frontMatter.skills))");
    expect(main).toContain("queueTypedLine(line)");
    expect(main).not.toContain("queuedSkillTurn");
  });
});
