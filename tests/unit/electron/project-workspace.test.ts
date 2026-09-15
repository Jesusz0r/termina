import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  newWorkspaceState,
  nextProjectId,
  nextWorkspaceId,
  pathInside,
  primaryWorkspaceOf,
  sanitizeSessionDir,
} from "../../../electron/main/project-workspace.ts";

describe("project-workspace bookkeeping", () => {
  it("allocates monotonic workspace and project ids", () => {
    const firstWs = nextWorkspaceId();
    const secondWs = nextWorkspaceId();
    expect(firstWs).toMatch(/^ws-\d+$/);
    expect(secondWs).not.toBe(firstWs);
    expect(nextProjectId()).toMatch(/^proj-\d+$/);
  });

  it("treats path containment as resolved relative containment", () => {
    const root = "/tmp/project";
    expect(pathInside(root, join(root, "src", "main.ts"))).toBe(true);
    expect(pathInside(root, root)).toBe(false);
    expect(pathInside(root, "/tmp/other/file.ts")).toBe(false);
  });

  it("slugifies a canonical path for session directories", () => {
    expect(sanitizeSessionDir("/Users/dev/proj/")).toBe("--Users-dev-proj--");
  });

  it("finds the primary workspace and builds a watcher-less record", () => {
    const primary = { id: "ws-1", primary: true };
    const candidate = { id: "ws-2", primary: false };
    expect(primaryWorkspaceOf([candidate, primary])).toEqual(primary);
    expect(primaryWorkspaceOf([candidate])).toBeNull();

    const ws = newWorkspaceState("/tmp/project", true);
    expect(ws.root).toBe("/tmp/project");
    expect(ws.primary).toBe(true);
    expect(ws.watcher).toBeNull();
    expect(ws.indexDone).toBe(false);
    expect(ws.id).toMatch(/^ws-\d+$/);
  });
});
