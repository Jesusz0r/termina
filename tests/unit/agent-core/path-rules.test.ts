import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildFrozenSystem } from "../../../agent-core/main/front-matter.ts";
import { attachPathRules, PATH_RULE_BYTES, scanSkills } from "../../../agent-core/main/skills.ts";
import { readProjectFile } from "../../../agent-core/main/file-ops.ts";
import { genericToolText } from "../../../agent-core/tool-output.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "termina-path-rules-")));
  roots.push(root);
  const project = join(root, "project");
  const skillsRoot = join(project, ".agents", "skills");
  const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  write(join(project, "src", "file.ts"), "source\n");
  write(join(project, "other.txt"), "other\n");
  const rule = (name: string, paths: unknown, body: string) => {
    const path = join(skillsRoot, name, "SKILL.md");
    write(path, `---\nname: ${name}\ndescription: Scoped guidance\npaths: ${JSON.stringify(paths)}\n---\n${body}`);
    return path;
  };
  const built = () => buildFrozenSystem({ cwd: project, userAgentsPath: null, userSkillDir: null, probes: false });
  const base = genericToolText("observed file content", false);
  return { root, project, skillsRoot, write, rule, built, base };
}

describe("path-scoped skill rules (#458)", () => {
  it("loads matching indexed bodies in the result, without changing the system prefix", () => {
    const f = fixture();
    const source = f.rule("typescript", ["src/**/*.ts"], "Keep the TYPESCRIPT_RULE invariant.");
    const built = f.built();
    expect(built.skills[0]?.paths).toEqual(["src/**/*.ts"]);
    expect(built.system).not.toContain("TYPESCRIPT_RULE");
    expect(built.system).not.toContain("src/**/*.ts");
    const output = attachPathRules(f.project, built.skills, ["src/file.ts"], f.base);
    expect(output.content).toContain("observed file content");
    expect(output.content).toContain(source);
    expect(output.content).toContain('["src/**/*.ts"]');
    expect(output.content).toContain("Keep the TYPESCRIPT_RULE invariant.");
    expect(output.content).not.toContain("paths:");
    f.write(source, "---\nname: typescript\ndescription: Scoped guidance\npaths: [\"src/**/*.ts\"]\n---\nUPDATED_RULE");
    expect(attachPathRules(f.project, built.skills, ["src/file.ts"], f.base).content).toContain("UPDATED_RULE");
    expect(f.built().system).toBe(built.system);
    expect(f.base.content).toBe("observed file content");
  });

  it("leaves misses, missing files and ancestor reads unchanged", () => {
    const f = fixture();
    f.rule("typescript", ["src/**/*.ts"], "TYPESCRIPT_RULE");
    f.write(join(f.root, "parent.ts"), "outside");
    f.write(join(f.root, ".agents", "skills", "ancestor", "SKILL.md"), '---\nname: ancestor\npaths: ["**"]\n---\nANCESTOR_RULE');
    const built = f.built();
    expect(built.skills.map(skill => skill.name)).toEqual(["typescript"]);
    for (const path of ["other.txt", "src/missing.ts", "src", "..", "../parent.ts"]) {
      expect(attachPathRules(f.project, built.skills, [path], f.base), path).toBe(f.base);
    }
  });

  it("matches canonical targets, refusing external symlinks and lexical alias matches", () => {
    const f = fixture();
    f.rule("canonical", ["src/**/*.ts"], "CANONICAL_RULE");
    f.rule("alias", ["alias.ts"], "ALIAS_RULE");
    f.write(join(f.root, "outside.ts"), "outside");
    symlinkSync(join(f.root, "outside.ts"), join(f.project, "outside.ts"));
    symlinkSync(join(f.root, "outside.ts"), join(f.project, "src", "external.ts"));
    symlinkSync(join(f.project, "src", "file.ts"), join(f.project, "alias.ts"));
    const { skills } = f.built();
    expect(attachPathRules(f.project, skills, ["src/external.ts"], f.base)).toBe(f.base);
    const alias = attachPathRules(f.project, skills, ["alias.ts"], f.base);
    expect(alias.content).toContain("CANONICAL_RULE");
    expect(alias.content).not.toContain("ALIAS_RULE");
  });

  it("does not discover escaped rule sources or follow a source replaced after indexing", () => {
    const f = fixture();
    const source = f.rule("local", ["**"], "LOCAL_RULE");
    const external = join(f.root, "outside", "SKILL.md");
    f.write(external, '---\nname: external\npaths: ["**"]\n---\nEXTERNAL_RULE');
    symlinkSync(dirname(external), join(f.skillsRoot, "escaped"));
    const built = f.built();
    expect(built.skills.map(skill => skill.name)).toEqual(["local"]);
    rmSync(source);
    symlinkSync(external, source);
    expect(attachPathRules(f.project, built.skills, ["src/file.ts"], f.base)).toBe(f.base);
  });

  it("caps all attached bodies together in UTF-8 and retains read continuation metadata", () => {
    const f = fixture();
    f.write(join(f.project, "src", "file.ts"), "source\n".repeat(10_000));
    f.rule("a", ["**/*.ts"], `MULTIBYTE_RULE ${"🧪".repeat(10_000)}`);
    f.rule("b", ["**/*.ts"], "SECOND_RULE");
    const original = readProjectFile(f.project, { path: "src/file.ts" });
    expect(original.continuation).toBeTruthy();
    const output = attachPathRules(f.project, f.built().skills, ["src/file.ts"], original);
    expect(output.truncated).toBe(true);
    expect(output.content).toContain("MULTIBYTE_RULE");
    expect(output.content).toContain("path rules truncated");
    expect(output.content).not.toContain("\uFFFD");
    expect(output.content).not.toContain("SECOND_RULE");
    expect(Buffer.byteLength(output.content) - Buffer.byteLength(original.content)).toBeLessThanOrEqual(PATH_RULE_BYTES);
    expect(output.outputBytes).toBe(Buffer.byteLength(output.content));
    expect(output.continuation).toBe(original.continuation);
    expect(output.repro).toBe(original.repro);
    expect(output.isError).toBe(original.isError);
  });

  it("attaches each matching rule once for a batch and excludes unrelated bodies", () => {
    const f = fixture();
    f.write(join(f.project, "src", "second.ts"), "second");
    f.rule("typescript", ["src/**/*.ts"], "ONCE_RULE");
    f.rule("docs", ["docs/**"], "DOCS_RULE");
    const output = attachPathRules(f.project, f.built().skills, ["src/file.ts", "src/second.ts", "other.txt"], f.base);
    expect(output.content.match(/ONCE_RULE/g)).toHaveLength(1);
    expect(output.content).not.toContain("DOCS_RULE");
  });

  it("fails closed on malformed, unsupported, absolute and parent patterns", () => {
    const f = fixture();
    for (const [name, paths] of Object.entries({ empty: [], parent: ["../**"], absolute: ["/src/**"], brace: ["src/*.{ts,js}"], mixed: ["src/**", 3], many: Array(17).fill("**") })) f.rule(name, paths, "INVALID_RULE");
    f.write(join(f.skillsRoot, "bad-json", "SKILL.md"), '---\nname: bad-json\npaths: ["src/**"\n---\nINVALID_RULE');
    const { skills } = scanSkills([f.skillsRoot]);
    expect(skills.every(skill => skill.paths === undefined)).toBe(true);
    expect(attachPathRules(f.project, skills, ["src/file.ts"], f.base)).toBe(f.base);
  });
});
