import { describe, expect, it, vi } from "vitest";
import type { FolderOpenedPayload, ProjectActivateResult } from "../../../shared/types";
import { activateProjectContext } from "../../../src/main/project-activation";

const folder: FolderOpenedPayload = {
  projectId: "project-B", workspaceId: "primary-B", cwd: "/projects/B",
  activationGeneration: 2, needsLogin: false,
};

function bindings(result: ProjectActivateResult = { ok: true, folder }) {
  return {
    request: vi.fn(async (): Promise<ProjectActivateResult> => result),
    prepareRenderer: vi.fn(async () => {}),
    applyFolder: vi.fn((_folder: FolderOpenedPayload) => {}),
    isCurrent: vi.fn((_folder: FolderOpenedPayload) => true),
    hasProject: vi.fn((_projectId: string) => true),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("authoritative project activation", () => {
  it("applies the main reply without depending on push delivery order", async () => {
    const host = bindings();
    expect(await activateProjectContext(folder.projectId, host)).toBe(true);
    expect(host.request).toHaveBeenCalledWith(folder.projectId);
    expect(host.applyFolder).toHaveBeenCalledWith(folder);
    expect(host.applyFolder.mock.invocationCallOrder[0]).toBeLessThan(host.isCurrent.mock.invocationCallOrder[0]!);
  });

  it("waits for main before preparing or changing the renderer", async () => {
    const reply = deferred<ProjectActivateResult>();
    const host = bindings();
    host.request.mockImplementation(() => reply.promise);
    const activation = activateProjectContext(folder.projectId, host);
    expect(host.applyFolder).not.toHaveBeenCalled();
    expect(host.prepareRenderer).not.toHaveBeenCalled();
    reply.resolve({ ok: true, folder });
    expect(await activation).toBe(true);
  });

  it("waits for the editor chunk before applying context", async () => {
    const ready = deferred<void>();
    const host = bindings();
    host.prepareRenderer.mockImplementation(() => ready.promise);
    const activation = activateProjectContext(folder.projectId, host);
    await Promise.resolve();
    expect(host.prepareRenderer).toHaveBeenCalled();
    expect(host.applyFolder).not.toHaveBeenCalled();
    ready.resolve();
    expect(await activation).toBe(true);
    expect(host.applyFolder).toHaveBeenCalledOnce();
  });

  it("does not apply a refused or superseded main activation", async () => {
    const host = bindings({ ok: false });
    expect(await activateProjectContext(folder.projectId, host)).toBe(false);
    expect(host.prepareRenderer).not.toHaveBeenCalled();
    expect(host.applyFolder).not.toHaveBeenCalled();
  });

  it("does not recreate a project closed while main was responding", async () => {
    const host = bindings();
    host.hasProject.mockReturnValue(false);
    expect(await activateProjectContext(folder.projectId, host)).toBe(false);
    expect(host.applyFolder).not.toHaveBeenCalled();
  });

  it("does not recreate a project closed while the editor chunk was loading", async () => {
    const ready = deferred<void>();
    const host = bindings();
    host.prepareRenderer.mockImplementation(() => ready.promise);
    const activation = activateProjectContext(folder.projectId, host);
    await Promise.resolve();
    host.hasProject.mockReturnValue(false);
    ready.resolve();
    expect(await activation).toBe(false);
    expect(host.applyFolder).not.toHaveBeenCalled();
  });

  it("cancels file navigation if a newer generation has already won", async () => {
    const host = bindings();
    host.isCurrent.mockReturnValue(false);
    expect(await activateProjectContext(folder.projectId, host)).toBe(false);
  });

  it("reports invoke failures to the caller without changing context", async () => {
    const host = bindings();
    host.request.mockRejectedValue(new Error("renderer unavailable"));
    await expect(activateProjectContext(folder.projectId, host)).rejects.toThrow("renderer unavailable");
    expect(host.applyFolder).not.toHaveBeenCalled();
  });
});
