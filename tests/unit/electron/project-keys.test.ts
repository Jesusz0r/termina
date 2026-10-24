import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectKeyRegistry } from "../../../electron/project-keys.ts";

const dirs: string[] = [];
async function registryFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "termina-project-keys-"));
  dirs.push(dir);
  return join(dir, "project-keys.json");
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("project key registry", () => {
  it("gives two roots that sanitize alike different keys, and keeps them across launches", async () => {
    const file = await registryFile();
    const first = new ProjectKeyRegistry(file);
    expect(await first.keyFor("/x/my-app")).toBe("--x-my-app--");
    expect(await first.keyFor("/x/my/app")).toBe("--x-my-app--2");
    expect(await first.keyFor("/x/my-app")).toBe("--x-my-app--");
    const relaunch = new ProjectKeyRegistry(file);
    expect(await relaunch.keyFor("/x/my/app")).toBe("--x-my-app--2");
    expect(await relaunch.keyFor("/x/my-app")).toBe("--x-my-app--");
  });

  it("serializes concurrent claims for one free name", async () => {
    const registry = new ProjectKeyRegistry(await registryFile());
    const keys = await Promise.all([registry.keyFor("/x/my-app"), registry.keyFor("/x/my/app")]);
    expect(new Set(keys).size).toBe(2);
  });

  it("keeps base names and leaves an unreadable registry untouched", async () => {
    const file = await registryFile();
    await writeFile(file, "{not json");
    const registry = new ProjectKeyRegistry(file);
    expect(await registry.keyFor("/x/my-app")).toBe("--x-my-app--");
    expect(await registry.keyFor("/x/my/app")).toBe("--x-my-app--");
    expect(await readFile(file, "utf8")).toBe("{not json");
  });

  it("ignores a hand-edited claim whose key does not belong to its root", async () => {
    const file = await registryFile();
    await writeFile(file, JSON.stringify({ claims: { "--x-my-app--": "/elsewhere" } }));
    expect(await new ProjectKeyRegistry(file).keyFor("/x/my-app")).toBe("--x-my-app--");
  });
});
