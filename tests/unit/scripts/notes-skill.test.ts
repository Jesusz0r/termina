import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildFrozenSystem } from "../../../agent-core/main/front-matter.ts";
import { readProjectFile } from "../../../agent-core/main/file-ops.ts";

const template = resolve("docs/examples/skills/notes");
const helper = join(template, "scripts/save-note.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "termina-notes-")));
  roots.push(root);
  return root;
}
function save(root: string, input: string | Buffer, args: string[] = []) {
  return spawnSync(process.execPath, ["--experimental-strip-types", helper, ...args], { cwd: root, input, encoding: "utf8" });
}

describe("notes skill", () => {
  it.each(["commonjs", "module", undefined])("runs a copied skill outside the project under %s package metadata", format => {
    const installed = project();
    writeFileSync(join(installed, "package.json"), JSON.stringify(format ? { type: format } : {}));
    const skill = join(installed, "user skills", "notes");
    mkdirSync(join(installed, "user skills"));
    cpSync(template, skill, { recursive: true });
    const root = project();
    const result = spawnSync(process.execPath, ["--experimental-strip-types", join(skill, "scripts/save-note.ts")], {
      cwd: root, input: "Saved outside the skill installation directory.", encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readProjectFile(root, { path: result.stdout.trim() }).content).toContain("Saved outside the skill installation directory.");
    expect(existsSync(join(installed, ".termina-notes"))).toBe(false);
    expect(existsSync(join(skill, ".termina-notes"))).toBe(false);
  });

  it("saves a new bounded note and reads it with the existing read_file implementation", () => {
    const root = project();
    const result = save(root, "Observed: reconnecting repeats the failure.\nNext: inspect cleanup.");
    expect(result.status, result.stderr).toBe(0);
    const path = result.stdout.trim();
    expect(path).toMatch(/^\.termina-notes[/\\][a-f0-9-]+\.md$/);
    const read = readProjectFile(root, { path });
    expect(read.isError).toBe(false);
    expect(read.content).toContain("Observed: reconnecting repeats the failure.");
    expect(read.content).toContain("Next: inspect cleanup.");
    expect(statSync(join(root, path)).size).toBeLessThan(17 * 1024);
    if (process.platform !== "win32") expect(statSync(join(root, path)).mode & 0o777).toBe(0o600);
  });

  it.each(["AGENTS.md", "FROZEN_IDENTITY", "agent-core/main/front-matter.ts", ".termina-notes/other-session.md", "../outside.md"])("refuses a caller-selected destination %s", target => {
    const root = project();
    mkdirSync(join(root, ".termina-notes"));
    mkdirSync(join(root, "agent-core/main"), { recursive: true });
    const protectedPaths = ["AGENTS.md", "FROZEN_IDENTITY", "agent-core/main/front-matter.ts", ".termina-notes/other-session.md"];
    for (const path of protectedPaths) writeFileSync(join(root, path), "unchanged");
    const result = save(root, "replacement", [target]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    for (const path of protectedPaths) expect(readFileSync(join(root, path), "utf8")).toBe("unchanged");
    expect(readdirSync(join(root, ".termina-notes"))).toEqual(["other-session.md"]);
  });

  it("never replaces existing notes, including when saves run concurrently", async () => {
    const root = project();
    mkdirSync(join(root, ".termina-notes"));
    writeFileSync(join(root, ".termina-notes/other-session.md"), "other session");
    const run = (body: string) => new Promise<string>((resolveDone, reject) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", helper], { cwd: root, stdio: "pipe" });
      let out = "";
      let err = "";
      child.stdout.on("data", chunk => { out += chunk.toString(); });
      child.stderr.on("data", chunk => { err += chunk.toString(); });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolveDone(out.trim()) : reject(new Error(err)));
      child.stdin.end(body);
    });
    const paths = await Promise.all([run("first session"), run("second session")]);
    expect(new Set(paths).size).toBe(2);
    expect(readFileSync(join(root, paths[0]!), "utf8")).toContain("first session");
    expect(readFileSync(join(root, paths[1]!), "utf8")).toContain("second session");
    expect(readFileSync(join(root, ".termina-notes/other-session.md"), "utf8")).toBe("other session");
  });

  it("rejects a symlinked notes directory, even when the destination is inside the project", () => {
    for (const external of [false, true]) {
      const root = project();
      const destination = external ? project() : join(root, "destination");
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, "AGENTS.md"), "unchanged");
      symlinkSync(destination, join(root, ".termina-notes"), "junction");
      expect(save(root, "must not be written").status).not.toBe(0);
      expect(readdirSync(destination)).toEqual(["AGENTS.md"]);
      expect(readFileSync(join(destination, "AGENTS.md"), "utf8")).toBe("unchanged");
    }
  });

  it.each(["", " ", "x".repeat(16 * 1024 + 1), "a\0b", Buffer.from([0xff])])("rejects empty, oversized, or non-text input", input => {
    const root = project();
    const result = save(root, input);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(readdirSync(root)).toEqual([]);
  });

  it("prints only the generated path, never note content or ambient credentials", () => {
    const root = project();
    const result = spawnSync(process.execPath, ["--experimental-strip-types", helper], {
      cwd: root, input: "Do not print this working context.", encoding: "utf8",
      env: { ...process.env, NOTES_TEST_SECRET: "synthetic-credential-not-for-output" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("working context");
    expect(result.stdout).not.toContain("synthetic-credential");
    expect(result.stderr).not.toContain("working context");
    expect(result.stderr).not.toContain("synthetic-credential");
  });

  it("discovers the skill while leaving saved notes and the skill body out of startup instructions", () => {
    const root = project();
    const skill = join(root, ".agents/skills/notes");
    mkdirSync(join(root, ".agents/skills"), { recursive: true });
    cpSync(template, skill, { recursive: true });
    const saved = save(root, "PRIVATE_WORKING_NOTE_SENTINEL");
    expect(saved.status).toBe(0);
    const frozen = buildFrozenSystem({ cwd: root, userAgentsPath: null, userSkillDir: null, probes: false });
    expect(frozen.skills.map(s => s.name)).toEqual(["notes"]);
    expect(frozen.skills[0]?.paths).toBeUndefined();
    expect(frozen.system).not.toContain("PRIVATE_WORKING_NOTE_SENTINEL");
    expect(frozen.system).not.toContain("save-note.ts");
    expect(readProjectFile(root, { path: join(skill, "SKILL.md") }, frozen.allow).isError).toBe(false);
    expect(readProjectFile(root, { path: saved.stdout.trim() }).content).toContain("PRIVATE_WORKING_NOTE_SENTINEL");
  });
});
