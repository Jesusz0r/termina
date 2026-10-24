// Per-project storage key for the terminal roster, core session directory,
// Session Search and mine marks. One owner: every keyed path asks here.
import { readFile } from "node:fs/promises";
import { durableAtomicWrite } from "../shared/durable-write.js";
import { evictOldest } from "../shared/evict-oldest.js";
import { isRecord } from "../shared/guards.js";
import { sanitizeSessionDir } from "./main/project-workspace.js";

/** Subagents also key candidate roots. Oldest claims go first; a dropped
 *  claim matters only if a colliding root appears afterwards. */
const MAX_PROJECT_KEY_CLAIMS = 1024;

/**
 * `sanitizeSessionDir` folds `/a/my-app` and `/a/my/app` into one name. The
 * first canonical root that uses a name claims it; another root with the
 * same name gets `<name>2`, `<name>3`, … A base name always ends in `--`, so
 * a suffixed key never equals a base key. Existing directories are never
 * moved: absolute session paths in worldline manifests stay valid. Data two
 * roots already shared before claims existed stays with the first claimant.
 */
export class ProjectKeyRegistry {
  /** key -> canonical root. `false`: the file is unreadable, so names stay unclaimed. */
  private claims: Map<string, string> | false | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  /** Serialized: two roots racing for one free name must not both take it. */
  keyFor(canonicalRoot: string): Promise<string> {
    const run = this.chain.then(() => this.claim(canonicalRoot));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async claim(root: string): Promise<string> {
    const claims = this.claims ?? await this.load();
    this.claims = claims;
    const base = sanitizeSessionDir(root);
    if (!claims) return base;
    for (const [key, owner] of claims) if (owner === root) return key;
    let key = base;
    for (let n = 2; claims.has(key); n++) key = `${base}${n}`;
    const next = new Map(claims).set(key, root);
    evictOldest(next, MAX_PROJECT_KEY_CLAIMS);
    // Durable before first use: a crash must not let another root claim a
    // name whose directory this root already wrote into.
    await durableAtomicWrite(this.file, `${JSON.stringify({ claims: Object.fromEntries(next) })}\n`);
    this.claims = next;
    return key;
  }

  private async load(): Promise<Map<string, string> | false> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
      // Rewriting a damaged file from an empty map could hand a claimed name
      // to a colliding root. Keep base names and leave the file for repair.
      console.warn(`[main] project key registry is unreadable: ${(error as Error).message}`);
      return false;
    }
    const claims = new Map<string, string>();
    if (isRecord(raw) && isRecord(raw.claims)) {
      for (const [key, root] of Object.entries(raw.claims)) {
        if (typeof root === "string" && key.startsWith(sanitizeSessionDir(root))) claims.set(key, root);
      }
    }
    return claims;
  }
}
