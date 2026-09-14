import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  homedir: vi.fn(),
  writeFile: vi.fn(),
  createOwnedDirectory: vi.fn(),
  prepareDirectory: vi.fn(),
  removeBoundOwnedDirectory: vi.fn(async () => {}),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: mocks.homedir,
}));

vi.mock("../../../electron/worldline-git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/worldline-git.ts")>();
  return {
    ...actual,
    createOwnedDirectory: mocks.createOwnedDirectory,
    boundPromotionPrepareDirectory: mocks.prepareDirectory,
    boundPromotionWriteFile: mocks.writeFile,
    removeBoundOwnedDirectory: mocks.removeBoundOwnedDirectory,
  };
});

import { EvidenceHomeStore } from "../../../electron/evidence-home.ts";

const identity = { dev: "1", ino: "1", capability: "cap" };

async function makeStore(home: string): Promise<{ store: EvidenceHomeStore; eventsDir: string; dest: string }> {
  const eventsDir = await mkdtemp(join(tmpdir(), "termina-evidence-events-"));
  const dest = join(eventsDir, "evidence-home-test");
  mocks.homedir.mockReturnValue(home);
  mocks.createOwnedDirectory.mockResolvedValue({
    path: dest,
    parentPath: eventsDir,
    identity,
    parentIdentity: identity,
  });
  mocks.prepareDirectory.mockResolvedValue({ identity });
  mocks.writeFile.mockResolvedValue({ identity, state: { type: "file", mode: 0o600, size: "1", sha256: "abc" } });
  const store = new EvidenceHomeStore({
    eventsDir: () => eventsDir,
    eventsBinding: () => identity,
  });
  return { store, eventsDir, dest };
}

describe("evidence-home resource copy (issue #247)", () => {
  afterEach(() => {
    mocks.writeFile.mockReset();
    mocks.createOwnedDirectory.mockReset();
    mocks.prepareDirectory.mockReset();
    mocks.removeBoundOwnedDirectory.mockReset();
    mocks.removeBoundOwnedDirectory.mockResolvedValue(undefined);
  });

  it("builds a home when agent resources are absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "termina-evidence-home-src-"));
    const { store, eventsDir } = await makeStore(home);
    try {
      const dir = await store.create();
      expect(dir).toContain("evidence-home-test");
      expect(mocks.writeFile).not.toHaveBeenCalled();
    } finally {
      await store.dispose();
      await rm(home, { recursive: true, force: true });
      await rm(eventsDir, { recursive: true, force: true });
    }
  });

  it("writes a present auth.json into the evidence home", async () => {
    const home = await mkdtemp(join(tmpdir(), "termina-evidence-home-src-"));
    const { store, eventsDir } = await makeStore(home);
    try {
      const agentDir = join(home, ".termina", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "auth.json"), '{"token":"x"}\n', { mode: 0o600 });
      await store.create();
      expect(mocks.writeFile).toHaveBeenCalledWith(expect.objectContaining({
        components: [".termina", "agent", "auth.json"],
        content: Buffer.from('{"token":"x"}\n'),
        mode: 0o600,
      }));
    } finally {
      await store.dispose();
      await rm(home, { recursive: true, force: true });
      await rm(eventsDir, { recursive: true, force: true });
    }
  });

  it("fails create when writing a present resource into the fresh home fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "termina-evidence-home-src-"));
    const { store, eventsDir } = await makeStore(home);
    mocks.writeFile.mockRejectedValueOnce(new Error("bound write failed: disk full"));
    try {
      const agentDir = join(home, ".termina", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "auth.json"), '{"token":"x"}\n', { mode: 0o600 });
      await expect(store.create()).rejects.toThrow(/could not write evidence auth\.json/);
      expect(mocks.removeBoundOwnedDirectory).toHaveBeenCalled();
    } finally {
      await store.dispose();
      await rm(home, { recursive: true, force: true });
      await rm(eventsDir, { recursive: true, force: true });
    }
  });
});
