import { describe, expect, it } from "vitest";
import { resolveFileNavigation } from "../../../src/main/file-navigation";

const projects = new Map([
  ["parent", { id: "parent", cwd: "/projects/app", workspaceId: "primary-parent" }],
  ["nested", { id: "nested", cwd: "/projects/app/nested", workspaceId: "primary-nested" }],
  ["other", { id: "other", cwd: "/projects/other", workspaceId: "primary-other" }],
]);
const parent = { projectId: "parent", workspaceId: "primary-parent" };

describe("file navigation ownership", () => {
  it("routes absolute links to another open project's primary workspace", () => {
    expect(resolveFileNavigation("/projects/other/file.ts", projects, parent)).toEqual({
      path: "/projects/other/file.ts",
      owner: { projectId: "other", workspaceId: "primary-other" },
    });
  });

  it("uses the canonical macOS spelling for both file paths and visible project roots", () => {
    const aliases = new Map([
      ["parent", { id: "parent", cwd: "/var/source", workspaceId: "primary-parent" }],
      ["nested", { id: "nested", cwd: "/var/source/nested", workspaceId: "primary-nested" }],
    ]);
    const physical = resolveFileNavigation("/private/var/source/nested/file.ts", aliases, parent);
    const visible = resolveFileNavigation("/var/source/nested/file.ts", aliases, parent);
    if (process.platform === "darwin") {
      expect(physical).toEqual({ path: "/private/var/source/nested/file.ts", owner: { projectId: "nested", workspaceId: "primary-nested" } });
      expect(visible).toEqual(physical);
    } else {
      // Those spellings are different directories on other platforms.
      expect(physical?.owner).toEqual(parent);
      expect(visible?.owner.projectId).toBe("nested");
    }
  });

  it("uses the longest matching root, not map insertion order", () => {
    expect(resolveFileNavigation("/projects/app/nested/file.ts", projects, parent)?.owner).toEqual({
      projectId: "nested", workspaceId: "primary-nested",
    });
  });

  it("does not mistake a similarly named root for a nested project", () => {
    expect(resolveFileNavigation("/projects/app/nested-other/file.ts", projects, parent)?.owner).toEqual(parent);
  });

  it("normalizes and decodes file URIs before routing", () => {
    expect(resolveFileNavigation("file://localhost/projects/other/src/../file%20name.ts", projects, parent)).toEqual({
      path: "/projects/other/file name.ts",
      owner: { projectId: "other", workspaceId: "primary-other" },
    });
  });

  it("keeps malformed URI escapes literal", () => {
    expect(resolveFileNavigation("src/file%name.ts", projects, parent)?.path).toBe("/projects/app/src/file%name.ts");
  });

  it("resolves relative links against the owning project, not the visible project", () => {
    expect(resolveFileNavigation("src/../file.ts", projects, parent)).toEqual({ path: "/projects/app/file.ts", owner: parent });
  });

  it("preserves an explicit candidate workspace outside primary roots", () => {
    const candidate = { projectId: "parent", workspaceId: "candidate-A" };
    expect(resolveFileNavigation("/worlds/candidate/file.ts", projects, candidate)).toEqual({
      path: "/worlds/candidate/file.ts", owner: candidate,
    });
  });

  it("never silently replaces a candidate owner with a primary workspace", () => {
    const candidate = { projectId: "parent", workspaceId: "candidate-A" };
    expect(resolveFileNavigation("/projects/other/file.ts", projects, candidate)?.owner).toEqual(candidate);
  });

  it("rejects a closed explicit owner rather than reassigning its files", () => {
    expect(resolveFileNavigation("/projects/other/file.ts", projects, { projectId: "closed", workspaceId: "old" })).toBeNull();
  });

  it("can route an absolute file without a previously selected owner", () => {
    expect(resolveFileNavigation("/projects/other/file.ts", projects, null)?.owner.projectId).toBe("other");
    expect(resolveFileNavigation("file.ts", projects, null)).toBeNull();
  });
});
