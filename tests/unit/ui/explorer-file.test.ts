import { describe, expect, it } from "vitest";
import {
  ancestorDirs,
  canDropEntry,
  computeChangedSets,
  deleteConfirmMessage,
  extensionOf,
  fileIconKind,
  filterKeeps,
  filterVisibleSet,
  findTypeAheadIndex,
  isMarkedChanged,
  isPathDescendant,
  isTypeAheadKey,
  normalizeRelPath,
  parentPath,
  parentRel,
  parentRowRel,
  projectChangedPaths,
  rowLevel,
  splitExtension,
  targetDirRel,
} from "../../../src/explorer-file.ts";

describe("explorer file visuals", () => {
  describe("extensionOf", () => {
    it("reads the extension without the dot", () => {
      expect(extensionOf("main.ts")).toBe("ts");
      expect(extensionOf("archive.tar.gz")).toBe("gz");
      expect(extensionOf("README")).toBe("");
      expect(extensionOf("Makefile")).toBe("");
    });

    it("treats a leading dot as a dotfile, not an extension", () => {
      expect(extensionOf(".env")).toBe("");
      expect(extensionOf(".gitignore")).toBe("");
    });

    it("ignores a trailing dot", () => {
      expect(extensionOf("weird.")).toBe("");
    });
  });

  describe("splitExtension", () => {
    it("keeps the dot on the extension", () => {
      expect(splitExtension("main.ts")).toEqual({ base: "main", ext: ".ts" });
    });

    it("splits on the last dot only", () => {
      expect(splitExtension("archive.tar.gz")).toEqual({ base: "archive.tar", ext: ".gz" });
    });

    it("leaves dotfiles and extensionless names whole", () => {
      expect(splitExtension(".env")).toEqual({ base: ".env", ext: "" });
      expect(splitExtension("Makefile")).toEqual({ base: "Makefile", ext: "" });
      expect(splitExtension("weird.")).toEqual({ base: "weird.", ext: "" });
    });

    it("reassembles to the original name", () => {
      for (const name of ["main.ts", "a.b.c", ".env", "README", "x.test.ts"]) {
        const { base, ext } = splitExtension(name);
        expect(base + ext).toBe(name);
      }
    });
  });

  describe("fileIconKind", () => {
    it("classifies code by language, not by name shape", () => {
      expect(fileIconKind("main.ts")).toBe("code");
      expect(fileIconKind("App.tsx")).toBe("code");
      expect(fileIconKind("lib.rs")).toBe("code");
      expect(fileIconKind("main.py")).toBe("code");
    });

    it("classifies config, docs, images and archives", () => {
      expect(fileIconKind("tsconfig.json")).toBe("config");
      expect(fileIconKind("ci.yml")).toBe("config");
      expect(fileIconKind("notes.md")).toBe("doc");
      expect(fileIconKind("logo.svg")).toBe("image");
      expect(fileIconKind("bundle.tgz")).toBe("archive");
    });

    it("falls back to a generic kind for unknown or extensionless files", () => {
      expect(fileIconKind("README")).toBe("file");
      expect(fileIconKind(".env")).toBe("file");
      expect(fileIconKind("thing.unknownext")).toBe("file");
    });

    it("prefers extension semantics over the plaintext language fallback", () => {
      // .md is markdown (not plaintext), but it must still read as a doc.
      expect(fileIconKind("README.md")).toBe("doc");
      expect(fileIconKind("data.csv")).toBe("config");
    });
  });

  describe("normalizeRelPath", () => {
    it("unifies separators", () => {
      expect(normalizeRelPath("src\\components\\a.ts")).toBe("src/components/a.ts");
      expect(normalizeRelPath("src/components/a.ts")).toBe("src/components/a.ts");
    });
  });

  describe("ancestorDirs", () => {
    it("lists outermost-first directories only", () => {
      expect(ancestorDirs("src/components/a.ts")).toEqual(["src", "src/components"]);
    });

    it("returns nothing for a root-level file", () => {
      expect(ancestorDirs("a.ts")).toEqual([]);
    });

    it("handles Windows separators", () => {
      expect(ancestorDirs("src\\components\\a.ts")).toEqual(["src", "src/components"]);
    });
  });

  describe("computeChangedSets", () => {
    it("marks the file, every ancestor directory, and the project root", () => {
      const { files, dirs } = computeChangedSets(["src/components/a.ts"]);
      expect([...files]).toEqual(["src/components/a.ts"]);
      // "" is the root row: it shows the marker when the root is collapsed.
      expect([...dirs].sort()).toEqual(["", "src", "src/components"]);
    });

    it("marks nothing for an empty list", () => {
      const { files, dirs } = computeChangedSets([]);
      expect(files.size).toBe(0);
      expect(dirs.size).toBe(0);
    });

    it("still marks the root for a root-level file", () => {
      const { files, dirs } = computeChangedSets(["a.ts"]);
      expect([...files]).toEqual(["a.ts"]);
      expect([...dirs]).toEqual([""]);
    });

    it("normalizes separators so Windows paths match the row data", () => {
      const { files, dirs } = computeChangedSets(["src\\a.ts"]);
      expect(files.has("src/a.ts")).toBe(true);
      expect(dirs.has("src")).toBe(true);
    });

    it("dedupes shared ancestors across files", () => {
      const { dirs } = computeChangedSets(["src/a.ts", "src/b.ts", "src/deep/c.ts"]);
      expect([...dirs].sort()).toEqual(["", "src", "src/deep"]);
    });

    it("ignores blank entries", () => {
      const { files, dirs } = computeChangedSets(["", "."]);
      expect(files.size).toBe(0);
      expect(dirs.size).toBe(0);
    });
  });

  describe("projectChangedPaths", () => {
    const pane = (projectId: string | null, workspaceId: string, relPaths: string[]) => ({
      projectId,
      workspaceId,
      modified: relPaths.map((relPath) => ({ relPath })),
    });

    it("unions changed paths across panes in the same workspace", () => {
      const paths = projectChangedPaths(
        [pane("p1", "w1", ["src/a.ts"]), pane("p1", "w1", ["src/b.ts"])],
        "p1",
        "w1",
      );
      expect(paths.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("excludes panes from another workspace (a candidate tree)", () => {
      // A worldline candidate shares the project id but has its own tree, so
      // the same relative path names a different file.
      const paths = projectChangedPaths(
        [pane("p1", "w1", ["src/a.ts"]), pane("p1", "w-candidate", ["src/a.ts", "src/c.ts"])],
        "p1",
        "w1",
      );
      expect(paths).toEqual(["src/a.ts"]);
    });

    it("excludes panes from another project", () => {
      const paths = projectChangedPaths(
        [pane("p1", "w1", ["a.ts"]), pane("p2", "w1", ["b.ts"])],
        "p1",
        "w1",
      );
      expect(paths).toEqual(["a.ts"]);
    });

    it("returns nothing without an active project", () => {
      expect(projectChangedPaths([pane("p1", "w1", ["a.ts"])], null, "w1")).toEqual([]);
    });

    it("dedupes a path reported by several panes", () => {
      const paths = projectChangedPaths(
        [pane("p1", "w1", ["src/a.ts"]), pane("p1", "w1", ["src/a.ts"])],
        "p1",
        "w1",
      );
      expect(paths).toEqual(["src/a.ts"]);
    });
  });

  describe("rowLevel", () => {
    it("numbers the root as level 1 and deepens per segment", () => {
      expect(rowLevel("")).toBe(1);
      expect(rowLevel("src")).toBe(2);
      // Nested under "src" (level 2), so one deeper.
      expect(rowLevel("src/index.ts")).toBe(3);
      expect(rowLevel("src/components/a.ts")).toBe(4);
    });

    it("normalizes separators", () => {
      expect(rowLevel("src\\components\\a.ts")).toBe(4);
    });

    it("treats the root sentinel as the root level", () => {
      expect(rowLevel(".")).toBe(1);
    });
  });

  describe("parentRowRel", () => {
    it("returns the root row for a top-level entry", () => {
      expect(parentRowRel("src")).toBe("");
      expect(parentRowRel("greeting.ts")).toBe("");
    });

    it("returns the containing folder for a nested entry", () => {
      expect(parentRowRel("src/index.ts")).toBe("src");
      expect(parentRowRel("src/components/a.ts")).toBe("src/components");
    });

    it("returns null for the root row itself", () => {
      expect(parentRowRel("")).toBeNull();
      expect(parentRowRel(".")).toBeNull();
    });
  });

  describe("targetDirRel", () => {
    it("puts a new entry inside a selected folder", () => {
      expect(targetDirRel({ relPath: "src", type: "dir" })).toBe("src");
      expect(targetDirRel({ relPath: "src/components", type: "dir" })).toBe("src/components");
    });

    it("puts a new entry beside a selected file", () => {
      expect(targetDirRel({ relPath: "src/index.ts", type: "file" })).toBe("src");
      expect(targetDirRel({ relPath: "greeting.ts", type: "file" })).toBe("");
    });

    it("normalizes separators", () => {
      expect(targetDirRel({ relPath: "src\\deep\\a.ts", type: "file" })).toBe("src/deep");
    });

    it("treats the root row as a folder with relPath ''", () => {
      expect(targetDirRel({ relPath: "", type: "dir" })).toBe("");
    });
  });

  describe("deleteConfirmMessage", () => {
    it("names a file", () => {
      expect(deleteConfirmMessage({ relPath: "src/a.ts", name: "a.ts", type: "file" }))
        .toBe('Delete file "src/a.ts"?');
    });

    it("says a folder delete is recursive", () => {
      // main runs `rm -rf` for a directory, so the message must not read as
      // if a single entry is removed.
      expect(deleteConfirmMessage({ relPath: "src", name: "src", type: "dir" }))
        .toBe('Delete folder "src" and everything inside it?');
    });

    it("falls back to the name when there is no relative path", () => {
      expect(deleteConfirmMessage({ relPath: "", name: "project", type: "dir" }))
        .toBe('Delete folder "project" and everything inside it?');
    });
  });

  describe("filterVisibleSet", () => {
    it("keeps a match, its ancestors, and the root", () => {
      const set = filterVisibleSet(["src/components/a.ts"]);
      expect([...set].sort()).toEqual(["", "src", "src/components", "src/components/a.ts"]);
    });

    it("keeps the root for a top-level match", () => {
      const set = filterVisibleSet(["greeting.ts"]);
      expect([...set].sort()).toEqual(["", "greeting.ts"]);
    });

    it("returns an EMPTY set for no matches, distinct from no filter", () => {
      // null means "no filter active"; an empty set means "the query matched
      // nothing". Conflating them would paint a no-match query as an
      // unfiltered tree.
      const set = filterVisibleSet([]);
      expect(set).not.toBeNull();
      expect(set.size).toBe(0);
    });

    it("ignores blank entries so they cannot fake a match", () => {
      expect(filterVisibleSet(["", ".", " "]).size).toBe(0);
    });

    it("normalizes separators so Windows paths match row data", () => {
      const set = filterVisibleSet(["src\\deep\\a.ts"]);
      expect(set.has("src/deep")).toBe(true);
      expect(set.has("src/deep/a.ts")).toBe(true);
    });

    it("unions shared ancestors across matches", () => {
      const set = filterVisibleSet(["src/a.ts", "src/deep/b.ts"]);
      expect([...set].sort()).toEqual(["", "src", "src/a.ts", "src/deep", "src/deep/b.ts"]);
    });
  });

  describe("filterKeeps", () => {
    it("keeps matches and ancestors, drops everything else", () => {
      const set = filterVisibleSet(["src/a.ts"]);
      expect(filterKeeps(set, "src/a.ts")).toBe(true);
      expect(filterKeeps(set, "src")).toBe(true);
      expect(filterKeeps(set, "")).toBe(true);
      expect(filterKeeps(set, "greeting.ts")).toBe(false);
      expect(filterKeeps(set, "src/other.ts")).toBe(false);
      expect(filterKeeps(set, "srcx")).toBe(false);
    });
  });

  describe("findTypeAheadIndex", () => {
    const names = ["src", "README.md", "readme-old.md", "package.json"];

    it("finds the next name starting with the buffer, searching forward", () => {
      expect(findTypeAheadIndex(names, 0, "p")).toBe(3);
    });

    it("wraps around the end of the list", () => {
      expect(findTypeAheadIndex(names, 3, "s")).toBe(0);
    });

    it("is case-insensitive", () => {
      expect(findTypeAheadIndex(names, 0, "READ")).toBe(1);
    });

    it("falls back to the first character when a longer buffer misses", () => {
      // "ss" matches nothing outright, so it cycles the "s" entries instead.
      expect(findTypeAheadIndex(names, 1, "ss")).toBe(0);
    });

    it("returns -1 when nothing matches", () => {
      expect(findTypeAheadIndex(names, 0, "zzz")).toBe(-1);
      expect(findTypeAheadIndex([], 0, "a")).toBe(-1);
      expect(findTypeAheadIndex(names, 0, "")).toBe(-1);
    });
  });

  describe("parentRel", () => {
    it("returns the containing folder", () => {
      expect(parentRel("src/components/explorer.ts")).toBe("src/components");
      expect(parentRel("src/main.ts")).toBe("src");
    });

    it("returns the root for top-level entries", () => {
      expect(parentRel("main.ts")).toBe("");
      expect(parentRel("")).toBe("");
    });
  });

  describe("parentPath", () => {
    it("climbs posix paths", () => {
      expect(parentPath("/proj/src/main.ts")).toBe("/proj/src");
      expect(parentPath("/proj/src")).toBe("/proj");
      expect(parentPath("/proj")).toBe("/");
    });

    it("climbs windows paths without changing the separator", () => {
      expect(parentPath("C:\\proj\\src\\main.ts")).toBe("C:\\proj\\src");
      expect(parentPath("C:\\proj\\src")).toBe("C:\\proj");
    });

    it("keeps the separator after a drive letter", () => {
      expect(parentPath("C:\\file")).toBe("C:\\");
    });
  });

  describe("isPathDescendant", () => {
    it("matches children at any depth under either separator", () => {
      expect(isPathDescendant("/a/b/c", "/a/b")).toBe(true);
      expect(isPathDescendant("/a/b/c/d", "/a/b")).toBe(true);
      expect(isPathDescendant("C:\\a\\b\\c", "C:\\a\\b")).toBe(true);
    });

    it("rejects the ancestor itself", () => {
      expect(isPathDescendant("/a/b", "/a/b")).toBe(false);
      expect(isPathDescendant("C:\\a\\b", "C:\\a\\b")).toBe(false);
    });

    it("rejects siblings with a shared prefix", () => {
      expect(isPathDescendant("/a/bb", "/a/b")).toBe(false);
      expect(isPathDescendant("C:\\a\\bb", "C:\\a\\b")).toBe(false);
    });
  });

  describe("canDropEntry", () => {
    it("rejects a missing or root source", () => {
      expect(canDropEntry(null, "src")).toBe(false);
      expect(canDropEntry({ relPath: "", type: "dir" }, "src")).toBe(false);
    });

    it("rejects a same-folder no-op", () => {
      expect(canDropEntry({ relPath: "src/main.ts", type: "file" }, "src")).toBe(false);
      expect(canDropEntry({ relPath: "main.ts", type: "file" }, "")).toBe(false);
    });

    it("accepts a real move", () => {
      expect(canDropEntry({ relPath: "src/main.ts", type: "file" }, "lib")).toBe(true);
      expect(canDropEntry({ relPath: "src/main.ts", type: "file" }, "")).toBe(true);
      expect(canDropEntry({ relPath: "src", type: "dir" }, "lib")).toBe(true);
    });

    it("rejects a folder dropped into itself or a descendant", () => {
      expect(canDropEntry({ relPath: "src", type: "dir" }, "src")).toBe(false);
      expect(canDropEntry({ relPath: "src", type: "dir" }, "src/components")).toBe(false);
    });

    it("accepts a folder dropped beside a shared-prefix sibling", () => {
      expect(canDropEntry({ relPath: "src", type: "dir" }, "src-old")).toBe(true);
    });
  });

  describe("isMarkedChanged", () => {
    const files = new Set(["src/main.ts"]);
    const dirs = new Set(["src", ""]);

    it("reads the file set for files", () => {
      expect(isMarkedChanged("file", "src/main.ts", files, dirs)).toBe(true);
      expect(isMarkedChanged("file", "src/other.ts", files, dirs)).toBe(false);
    });

    it("reads the ancestor set for directories", () => {
      expect(isMarkedChanged("dir", "src", files, dirs)).toBe(true);
      expect(isMarkedChanged("dir", "lib", files, dirs)).toBe(false);
    });

    it("normalizes separators before the lookup", () => {
      expect(isMarkedChanged("file", "src\\main.ts", files, dirs)).toBe(true);
    });

    it("treats a missing type as a file", () => {
      expect(isMarkedChanged(undefined, "src/main.ts", files, dirs)).toBe(true);
    });
  });

  describe("isTypeAheadKey", () => {
    it("accepts single printable characters", () => {
      expect(isTypeAheadKey("a")).toBe(true);
      expect(isTypeAheadKey("Z")).toBe(true);
      expect(isTypeAheadKey("1")).toBe(true);
      expect(isTypeAheadKey(".")).toBe(true);
    });

    it("rejects space, empty, and multi-character keys", () => {
      expect(isTypeAheadKey(" ")).toBe(false);
      expect(isTypeAheadKey("")).toBe(false);
      expect(isTypeAheadKey("Enter")).toBe(false);
      expect(isTypeAheadKey("F2")).toBe(false);
    });
  });
});
