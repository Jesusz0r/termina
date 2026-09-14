import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  homedir: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: mocks.homedir,
}));

vi.mock("../../../electron/worldline-git.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../electron/worldline-git.ts")>();
  return {
    ...actual,
    boundPromotionWriteFile: vi.fn((args: Parameters<typeof actual.boundPromotionWriteFile>[0]) => actual.boundPromotionWriteFile(args)),
  };
});

import { EvidenceHomeStore } from "../../../electron/evidence-home.ts";
import { boundPromotionOpenDirectory, boundPromotionWriteFile } from "../../../electron/worldline-git.ts";

const mockWriteFile = vi.mocked(boundPromotionWriteFile);

async function makeStore(home: string): Promise<{
  store: EvidenceHomeStore;
  eventsDir: string;
}> {
  const eventsDir = await realpath(await mkdtemp(join(tmpdir(), "termina-evidence-events-")));
  const eventsBinding = await boundPromotionOpenDirectory({ path: eventsDir });
  mocks.homedir.mockReturnValue(home);
  const store = new EvidenceHomeStore({
    eventsDir: () => eventsDir,
    eventsBinding: () => eventsBinding,
  });
  return { store, eventsDir };
}

describe("evidence-home resource copy (issue #247)", () => {
  afterEach(() => {
    mockWriteFile.mockClear();
  });

  it("builds a home when agent resources are absent", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "termina-evidence-home-src-")));
    const { store, eventsDir } = await makeStore(home);
    try {
      const dir = await store.create();
      expect(dir.startsWith(eventsDir)).toBe(true);
      await expect(readFile(join(dir, ".termina", "agent", "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await store.remove(dir);
    } finally {
      await store.dispose();
      await rm(home, { recursive: true, force: true });
      await rm(eventsDir, { recursive: true, force: true });
    }
  });

  it("copies a present auth.json into the evidence home", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "termina-evidence-home-src-")));
    const { store, eventsDir } = await makeStore(home);
    try {
      const agentDir = join(home, ".termina", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "auth.json"), '{"token":"x"}\n', { mode: 0o600 });
      const dir = await store.create();
      expect(await readFile(join(dir, ".termina", "agent", "auth.json"), "utf8")).toBe('{"token":"x"}\n');
      await store.remove(dir);
    } finally {
      await store.dispose();
      await rm(home, { recursive: true, force: true });
      await rm(eventsDir, { recursive: true, force: true });
    }
  });

  it("fails create when writing a present resource into the fresh home fails", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "termina-evidence-home-src-")));
    const { store, eventsDir } = await makeStore(home);
    mockWriteFile.mockRejectedValueOnce(new Error("bound write failed: disk full"));
    try {
      const agentDir = join(home, ".termina", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "auth.json"), '{"token":"x"}\n', { mode: 0o600 });
      await expect(store.create()).rejects.toThrow(/could not write evidence auth\.json/);
    } finally {
      await store.dispose();
      await rm(home, { recursive: true, force: true });
      await rm(eventsDir, { recursive: true, force: true });
    }
  });
});
