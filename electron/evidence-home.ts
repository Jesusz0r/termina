/**
 * Evidence homes: bounded, descriptor-bound HOME directories for sandboxed
 * evidence runs. Each home carries a copy of the real agent resources plus
 * tmp/A and tmp/B. Removal and dispose go only through the binding captured
 * at creation; a failed identity proof retains the directory on purpose.
 */
import { stat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  boundPromotionPrepareDirectory,
  boundPromotionWriteFile,
  createOwnedDirectory,
  removeBoundOwnedDirectory,
  type BoundOwnedDirectory,
  type PromotionFsIdentity,
} from "./worldline-git.js";

const MAX_AGENT_RESOURCE_BYTES = 200 * 1024 * 1024;

/** Live reads into main-owned state, evaluated at call time. */
export interface EvidenceHomeHost {
  eventsDir(): string;
  eventsBinding(): PromotionFsIdentity | null;
}

export class EvidenceHomeStore {
  private dirs = new Map<string, BoundOwnedDirectory>();

  constructor(private readonly host: EvidenceHomeHost) {}

  /** Create a bounded evidence home from the real agent resources. */
  async create(): Promise<string> {
    const eventsBinding = this.host.eventsBinding();
    if (!eventsBinding) throw new Error("events directory is not bound");
    let dir: string | null = null;
    let binding: BoundOwnedDirectory | null = null;
    let complete = false;
    try {
      binding = await createOwnedDirectory(this.host.eventsDir(), eventsBinding, "evidence-home-");
      dir = binding.path;
      this.dirs.set(dir, binding);
      // The evidence home is allocated once by the native descriptor-bound
      // owner. Every destination directory and file is then created below
      // that retained capability; no awaited pathname `mkdir`/`copyFile` can
      // be redirected to a replacement ancestor.
      const agent = await boundPromotionPrepareDirectory({
        root: dir,
        rootIdentity: binding.identity,
        components: [".termina", "agent"],
        createMissing: true,
      });
      if (!agent.identity) throw new Error("evidence agent directory was not created");
      const agentSrc = join(homedir(), ".termina", "agent");
      for (const name of ["auth.json", "mcp.json"]) {
        try {
          const source = join(agentSrc, name);
          const info = await stat(source);
          if (!info.isFile() || info.size > MAX_AGENT_RESOURCE_BYTES) continue;
          const content = await readFile(source);
          await boundPromotionWriteFile({
            root: dir,
            rootIdentity: binding.identity,
            components: [".termina", "agent", name],
            parentIdentity: agent.identity,
            expectedDestination: { state: { type: "missing" } },
            content,
            mode: 0o600,
          });
        } catch {
          /* The resource is optional. */
        }
      }
      for (const name of ["A", "B"]) {
        const tmp = await boundPromotionPrepareDirectory({
          root: dir,
          rootIdentity: binding.identity,
          components: ["tmp", name],
          createMissing: true,
        });
        if (!tmp.identity) throw new Error(`evidence tmp/${name} directory was not created`);
      }
      complete = true;
      return dir;
    } finally {
      if (!complete && dir) {
        this.dirs.delete(dir);
        if (binding) await removeBoundOwnedDirectory({ binding }).catch(() => undefined);
      }
    }
  }

  /** Remove an evidence home only through the binding captured at creation. */
  async remove(path: string): Promise<boolean> {
    const binding = this.dirs.get(path);
    if (!binding) return false;
    try {
      await removeBoundOwnedDirectory({ binding });
      this.dirs.delete(path);
      return true;
    } catch (error) {
      // Keep the binding so a later lifecycle/dispose cleanup can retry.  A
      // replacement parent or leaf is deliberately retained on uncertainty.
      console.warn(`[main] evidence home cleanup retained ${path}: ${String(error)}`);
      return false;
    }
  }

  /** Final teardown: retry every home once, then drop the retry handles. */
  async dispose(): Promise<void> {
    for (const [path, binding] of [...this.dirs]) {
      if (await this.remove(path)) continue;
      // The failed identity proof intentionally retains the replacement.
      // Drop only the in-memory retry handle during final app teardown.
      this.dirs.delete(path);
      void binding;
    }
  }
}
