import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatEnvironment } from "../../../agent-core/main/env.ts";
import { editProjectFile, expandFileTags, readProjectFile } from "../../../agent-core/main/file-ops.ts";
import {
  GREP_VISIT_CAP,
  IGNORE_FILE_CAP_BYTES,
  collectFiles,
  fileHasNul,
  globFiles,
  openRegularFile,
  readBoundedRegularFile,
  readIgnoreFile,
} from "../../../agent-core/main/files.ts";
import { buildFrozenSystem } from "../../../agent-core/main/front-matter.ts";
import { scanSkills } from "../../../agent-core/main/skills.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "termina-file-special-"));
  roots.push(root);
  // Production callers canonicalize (freezeCwd/confinePath); macOS tmpdirs
  // are symlinked (/var -> /private/var), so tests must too before
  // asserting on walked paths.
  return realpathSync(root);
}

function makeFifo(path: string): boolean {
  const made = spawnSync("mkfifo", [path]);
  return made.status === 0;
}

/** FIFO tests must fail fast, not hang: a blocking regression trips the timeout. */
const FAST = { timeout: 10_000 };

describe("regular-file opener (#155)", () => {
  it("opens ordinary files with size and mode", () => {
    const root = project();
    writeFileSync(join(root, "a.txt"), "hello");
    const opened = openRegularFile(join(root, "a.txt"));
    if ("error" in opened) throw new Error(`unexpected opener error: ${opened.error}`);
    expect(opened.size).toBe(5);
    expect(typeof opened.mode).toBe("number");
    closeSync(opened.fd);
  });

  it("rejects directories and missing paths without blocking", () => {
    const root = project();
    expect(openRegularFile(root)).toEqual({ error: "error: path is a directory" });
    const missing = openRegularFile(join(root, "nope.txt"));
    expect("error" in missing && missing.error.startsWith("error:")).toBe(true);
  });

  it("rejects FIFOs, symlink-to-FIFO, and devices without blocking", () => {
    const root = project();
    const fifo = join(root, "pipe");
    expect(makeFifo(fifo)).toBe(true);
    expect(openRegularFile(fifo)).toEqual({ error: "error: not a regular file" });
    const link = join(root, "link");
    symlinkSync(fifo, link);
    expect(openRegularFile(link)).toEqual({ error: "error: not a regular file" });
    try {
      expect(openRegularFile("/dev/null")).toEqual({ error: "error: not a regular file" });
    } catch {
      // Non-POSIX platforms have no /dev/null; the FIFO cases above still apply.
    }
  });

  it("reads bounded text with truncation signals", () => {
    const root = project();
    writeFileSync(join(root, "a.txt"), "hello");
    expect(readBoundedRegularFile(join(root, "a.txt"), 1024)).toEqual({ text: "hello", truncated: false });
    expect(readBoundedRegularFile(join(root, "a.txt"), 3)).toEqual({ text: "hel", truncated: true });
    const missing = readBoundedRegularFile(join(root, "nope.txt"), 8);
    expect("error" in missing).toBe(true);
  });
});

describe("file tools on special files (#155)", () => {
  it("read_file errors quickly on a FIFO without a writer", FAST, () => {
    const root = project();
    const fifo = join(root, "pipe");
    expect(makeFifo(fifo)).toBe(true);
    const started = Date.now();
    const got = readProjectFile(root, { path: "pipe" });
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(got.isError).toBe(true);
    expect(got.content).toContain("not a regular file");
  });

  it("edit errors quickly on a FIFO without mutating it", FAST, () => {
    const root = project();
    const fifo = join(root, "pipe");
    expect(makeFifo(fifo)).toBe(true);
    const started = Date.now();
    const got = editProjectFile(root, "pipe", "a", "b");
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(got.isError).toBe(true);
    expect(got.content).toContain("not a regular file");
  });

  it("edit still reports directories distinctly", () => {
    const root = project();
    mkdirSync(join(root, "sub"));
    expect(editProjectFile(root, "sub", "a", "b")).toEqual({ content: "error: EISDIR", isError: true });
  });

  it("@ tags skip FIFOs instead of blocking prompt expansion", FAST, () => {
    const root = project();
    const fifo = join(root, "pipe");
    expect(makeFifo(fifo)).toBe(true);
    const started = Date.now();
    expect(expandFileTags(root, "look at @pipe please")).toBe("look at @pipe please");
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
  });

  it("glob skips FIFOs and stays within budget", FAST, async () => {
    const root = project();
    expect(makeFifo(join(root, "pipe"))).toBe(true);
    writeFileSync(join(root, "a.txt"), "x");
    const started = Date.now();
    const got = await collectFiles(root, root, GREP_VISIT_CAP, { budgetMs: 10 });
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(got.files).toContain(join(root, "a.txt"));
    expect(got.files).not.toContain(join(root, "pipe"));
  });

  it("skill discovery skips FIFO skill files", FAST, () => {
    const root = project();
    const skillsDir = join(root, "skills");
    mkdirSync(join(skillsDir, "ok"), { recursive: true });
    writeFileSync(join(skillsDir, "ok", "SKILL.md"), "---\nname: ok\n---\n");
    mkdirSync(join(skillsDir, "hung"), { recursive: true });
    expect(makeFifo(join(skillsDir, "hung", "SKILL.md"))).toBe(true);
    const started = Date.now();
    const { skills } = scanSkills([skillsDir]);
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(skills.map((s) => s.name)).toEqual(["ok"]);
  });

  it("NUL probing treats special files as unscannable", FAST, () => {
    const root = project();
    const fifo = join(root, "pipe");
    expect(makeFifo(fifo)).toBe(true);
    const started = Date.now();
    expect(fileHasNul(fifo)).toBe(true);
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
  });
});

describe("ignore and instruction reads (#155)", () => {
  it("omits FIFO, directory, oversized, and missing ignore files", FAST, () => {
    const root = project();
    const fifo = join(root, "fifo-gi");
    expect(makeFifo(fifo)).toBe(true);
    const started = Date.now();
    expect(readIgnoreFile(fifo)).toBeNull();
    expect(readIgnoreFile(root)).toBeNull();
    expect(readIgnoreFile(join(root, "nope"))).toBeNull();
    writeFileSync(join(root, "big"), "x".repeat(IGNORE_FILE_CAP_BYTES + 8));
    expect(readIgnoreFile(join(root, "big"))).toBeNull();
    writeFileSync(join(root, "small"), "*.log\n");
    expect(readIgnoreFile(join(root, "small"))).toBe("*.log\n");
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
  });

  it("startup environment build survives a FIFO .gitignore", FAST, () => {
    const root = project();
    expect(makeFifo(join(root, ".gitignore"))).toBe(true);
    writeFileSync(join(root, "a.txt"), "x");
    const started = Date.now();
    const env = formatEnvironment(root, { probes: false });
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(env).toContain("<environment>");
  });

  it("directory listings survive a FIFO .gitignore", FAST, () => {
    const root = project();
    expect(makeFifo(join(root, ".gitignore"))).toBe(true);
    writeFileSync(join(root, "a.txt"), "x");
    const started = Date.now();
    const got = readProjectFile(root, { path: "." });
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(got.isError).toBe(false);
    expect(got.content).toContain("a.txt");
  });

  it("instruction freeze survives a FIFO project AGENTS.md", FAST, () => {
    const root = project();
    expect(makeFifo(join(root, "AGENTS.md"))).toBe(true);
    const started = Date.now();
    const built = buildFrozenSystem({ cwd: root, userAgentsPath: null, userSkillDir: null, probes: false });
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(built.system).toContain("<agent_core>");
  });

  it("globFiles tool omits rules from a FIFO .gitignore", FAST, async () => {
    const root = project();
    expect(makeFifo(join(root, ".gitignore"))).toBe(true);
    writeFileSync(join(root, "keep.txt"), "x");
    const started = Date.now();
    const got = await globFiles(root, "*.txt");
    expect(Date.now() - started).toBeLessThan(FAST.timeout);
    expect(got.content).toContain("keep.txt");
  });
});
