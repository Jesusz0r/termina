import { describe, expect, it } from "vitest";
import { canonicalizePath } from "../../../shared/canonical-path.ts";
import { isPathDescendant } from "../../../src/explorer-file.ts";

describe("canonicalizePath", () => {
  it("rewrites macOS /tmp and /var aliases", () => {
    expect(canonicalizePath("/tmp", "darwin")).toBe("/private/tmp");
    expect(canonicalizePath("/tmp/proj/file.ts", "darwin")).toBe("/private/tmp/proj/file.ts");
    expect(canonicalizePath("/var", "darwin")).toBe("/private/var");
    expect(canonicalizePath("/var/folders/xx/proj", "darwin")).toBe("/private/var/folders/xx/proj");
  });

  it("is a no-op for already-canonical macOS paths", () => {
    expect(canonicalizePath("/private/tmp", "darwin")).toBe("/private/tmp");
    expect(canonicalizePath("/private/tmp/proj/file.ts", "darwin")).toBe("/private/tmp/proj/file.ts");
    expect(canonicalizePath("/private/var/folders/xx/proj", "darwin")).toBe("/private/var/folders/xx/proj");
    expect(canonicalizePath("/Users/ada/src", "darwin")).toBe("/Users/ada/src");
  });

  it("does not rewrite a shared prefix that is not the alias", () => {
    expect(canonicalizePath("/tmpfoo", "darwin")).toBe("/tmpfoo");
    expect(canonicalizePath("/variable", "darwin")).toBe("/variable");
  });

  it("is identity off macOS", () => {
    expect(canonicalizePath("/tmp/proj/file.ts", "linux")).toBe("/tmp/proj/file.ts");
    expect(canonicalizePath("/var/folders/xx/proj", "linux")).toBe("/var/folders/xx/proj");
    expect(canonicalizePath("/tmp/proj/file.ts", "win32")).toBe("/tmp/proj/file.ts");
    expect(canonicalizePath("/var/folders/xx/proj", "win32")).toBe("/var/folders/xx/proj");
  });

  it("makes prefix descent work across the as-opened and canonical spellings", () => {
    const root = canonicalizePath("/var/folders/xx/proj", "darwin");
    expect(isPathDescendant("/private/var/folders/xx/proj/src", root)).toBe(true);
    expect(isPathDescendant(canonicalizePath("/tmp/proj/src/main.ts", "darwin"), canonicalizePath("/tmp/proj", "darwin"))).toBe(true);
  });
});
