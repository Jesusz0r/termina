import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { READ_BATCH_CAP, readProjectFile, readProjectFiles } from "../../../agent-core/main/file-ops.ts";
import { builtinClientTools } from "../../../agent-core/main.ts";
import { toolInputError } from "../../../agent-core/tool-dispatch.ts";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "termina-read-batch-"));
  roots.push(root);
  return realpathSync(root);
}

function header(content: string, path: string): boolean {
  return content.includes(`<file path="${path}">`);
}

describe("batched read_file", () => {
  it("reads several files in one bounded result", () => {
    const root = project();
    writeFileSync(join(root, "a.txt"), "alpha\n");
    writeFileSync(join(root, "b.txt"), "beta\n");
    const got = readProjectFiles(root, { paths: ["a.txt", "b.txt"] });
    expect(got.isError).toBe(false);
    expect(header(got.content, "a.txt")).toBe(true);
    expect(header(got.content, "b.txt")).toBe(true);
    expect(got.content).toContain("alpha");
    expect(got.content).toContain("beta");
    expect(Buffer.byteLength(got.content, "utf8")).toBeLessThanOrEqual(40 * 1024);
    expect(got.repro).toBe("read_file(2 paths)");
  });

  it("keeps per-file failures inline unless every file failed", () => {
    const root = project();
    writeFileSync(join(root, "ok.txt"), "fine\n");
    const partial = readProjectFiles(root, { paths: ["ok.txt", "missing.txt"] });
    expect(partial.isError).toBe(false);
    expect(partial.content).toContain("fine");
    expect(partial.content).toContain("missing.txt");
    const all = readProjectFiles(root, { paths: ["no-a.txt", "no-b.txt"] });
    expect(all.isError).toBe(true);
  });

  it("enforces the jail per file", () => {
    const root = project();
    writeFileSync(join(root, "in.txt"), "inside\n");
    const got = readProjectFiles(root, { paths: ["in.txt", "../outside.txt"] });
    expect(got.isError).toBe(false);
    expect(got.content).toContain("inside");
    expect(got.content).toContain("outside project");
  });

  it("rejects mixed selectors, windows, and malformed batches", () => {
    const root = project();
    writeFileSync(join(root, "a.txt"), "x\n");
    expect(readProjectFiles(root, { path: "a.txt", paths: ["a.txt"] }).isError).toBe(true);
    expect(readProjectFiles(root, { paths: ["a.txt"], offset: 1 }).isError).toBe(true);
    expect(readProjectFiles(root, { paths: ["a.txt"], start_line: 1 }).isError).toBe(true);
    expect(readProjectFiles(root, { paths: ["a.txt"], end_line: 2 }).isError).toBe(true);
    expect(readProjectFiles(root, { paths: [] }).isError).toBe(true);
    expect(readProjectFiles(root, { paths: "a.txt" }).isError).toBe(true);
    expect(readProjectFiles(root, { paths: ["a.txt", "a.txt"] }).content).toContain("duplicate");
    expect(readProjectFiles(root, { paths: ["a.txt", 7] }).isError).toBe(true);
    expect(readProjectFiles(root, { paths: [""] }).isError).toBe(true);
    const many = Array.from({ length: READ_BATCH_CAP + 1 }, (_, i) => `f${i}.txt`);
    expect(readProjectFiles(root, { paths: many }).content).toContain(`caps at ${READ_BATCH_CAP}`);
  });

  it("omits whole tail files with an explicit re-read hint", () => {
    const root = project();
    const line = `${"q".repeat(96)}\n`;
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(root, name), line.repeat(150));
    const got = readProjectFiles(root, { paths: ["a.txt", "b.txt", "c.txt"] });
    expect(got.isError).toBe(false);
    expect(got.truncated).toBe(true);
    expect(header(got.content, "a.txt")).toBe(true);
    expect(header(got.content, "c.txt")).toBe(false);
    expect(got.content).toContain("omitted");
    expect(got.content).toContain("c.txt");
    expect(String(got.continuation ?? "")).toContain("c.txt");
    expect(Buffer.byteLength(got.content, "utf8")).toBeLessThanOrEqual(40 * 1024);
  });

  it("reads a single-entry batch exactly like a single read", () => {
    const root = project();
    writeFileSync(join(root, "a.txt"), "solo\n");
    const single = readProjectFile(root, { path: "a.txt" });
    const batch = readProjectFiles(root, { paths: ["a.txt"] });
    expect(batch.isError).toBe(single.isError);
    expect(batch.content).toBe(single.content);
  });

  it("publishes the paths selector in the tool schema", () => {
    const def = builtinClientTools().find((tool) => tool.name === "read_file") as Record<string, any>;
    const schema = def.input_schema as { properties: Record<string, any>; required: string[] };
    expect(schema.properties.paths?.type).toBe("array");
    expect(schema.required).not.toContain("path");
    const defs = builtinClientTools() as Array<Record<string, unknown>>;
    expect(toolInputError({ name: "read_file", input: { paths: ["a.txt"] } }, defs)).toBeNull();
    expect(toolInputError({ name: "read_file", input: { paths: "a.txt" } }, defs)).toContain("paths must be array");
  });
});
