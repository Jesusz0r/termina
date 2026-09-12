/**
 * Promotion journals and artifact manifests.
 *
 * Owns journal writes, journal validation, and artifact manifests.
 * Split from promotion-recovery.ts (issue #38).
 */
import { boundPromotionWriteFile, type PromotionFsIdentity } from "../../worldline-git.js";
import { promotionIdentityOf } from "../bindings.js";
import { MAX_PROMOTION_OPERATION_BYTES, MAX_PROMOTION_SCAN_DEPTH, MAX_PROMOTION_SCAN_ENTRIES, MAX_PROMOTION_SCAN_PENDING, MAX_PROMOTION_SCAN_WORK_BYTES } from "../limits.js";
import { type PromotionArtifactEntry, type PromotionArtifactManifest, type PromotionEntryState, type PromotionJournalBinding, type PromotionJournalPath, type PromotionRecoveryTestHook } from "../types.js";
import { boundedWorldlineEntries } from "../uncertain-comparison.js";
import { lstat as lstatPath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { isMaterializedPromotionState, isRestorablePromotionState, promotionStateHash, readPromotionEntry } from "./entry-state.js";
import { EMPTY_PROMOTION_HASH, SHA256_HEX, exactObjectKeys, isSafePromotionRelativePath, statIdentityEqual } from "./primitives.js";



export async function createPromotionArtifactManifest(path: string): Promise<PromotionArtifactManifest> {
  const entries: PromotionArtifactEntry[] = [];
  const initialWorkBytes = Buffer.byteLength(path, "utf8");
  if (initialWorkBytes > MAX_PROMOTION_SCAN_WORK_BYTES) throw new Error("promotion artifact path exceeds its bounded work budget");
  const pending: Array<{ path: string; relative: string; depth: number; workBytes: number }> = [{ path, relative: ".", depth: 0, workBytes: initialWorkBytes }];
  let pendingWorkBytes = initialWorkBytes;
  let measuredBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    pendingWorkBytes -= current.workBytes;
    if (current.depth > MAX_PROMOTION_SCAN_DEPTH) throw new Error(`promotion artifact exceeds its ${MAX_PROMOTION_SCAN_DEPTH}-level depth bound`);
    const info = await lstatPath(current.path);
    if (!Number.isSafeInteger(info.size) || measuredBytes > MAX_PROMOTION_OPERATION_BYTES - info.size) throw new Error("promotion artifact exceeds its bounded byte budget");
    measuredBytes += info.size;
    const observed = await readPromotionEntry(current.path);
    const after = await lstatPath(current.path);
    if (!statIdentityEqual(info, after)) {
      throw new Error(`promotion artifact changed while recording: ${current.path}`);
    }
    if (entries.length >= MAX_PROMOTION_SCAN_ENTRIES) throw new Error(`promotion artifact exceeds its ${MAX_PROMOTION_SCAN_ENTRIES}-entry bound`);
    entries.push({ rel: current.relative, dev: info.dev, ino: info.ino, state: observed.state });
    if (!info.isDirectory()) continue;
    const names = await boundedWorldlineEntries(current.path, MAX_PROMOTION_SCAN_ENTRIES, `promotion artifact contains too many child entries`);
    names.sort().reverse();
    for (const name of names) {
      if (pending.length >= MAX_PROMOTION_SCAN_PENDING) throw new Error(`promotion artifact exceeds its ${MAX_PROMOTION_SCAN_PENDING}-entry pending bound`);
      const childPath = join(current.path, name);
      const childRelative = current.relative === "." ? name : join(current.relative, name);
      const workBytes = Buffer.byteLength(childPath, "utf8") + Buffer.byteLength(childRelative, "utf8");
      if (workBytes > MAX_PROMOTION_SCAN_WORK_BYTES || pendingWorkBytes > MAX_PROMOTION_SCAN_WORK_BYTES - workBytes) {
        throw new Error("promotion artifact scan exceeded its bounded work budget");
      }
      pending.push({ path: childPath, relative: childRelative, depth: current.depth + 1, workBytes });
      pendingWorkBytes += workBytes;
    }
  }
  return { status: "created", path, entries };
}


export function parsePromotionArtifactManifest(value: unknown, field: string): PromotionArtifactManifest | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${field} manifest`);
  const manifest = value as Record<string, unknown>;
  if (manifest.status === "planned" && exactObjectKeys(manifest, ["status", "path"]) && typeof manifest.path === "string" && isAbsolute(manifest.path)) {
    return { status: "planned", path: manifest.path };
  }
  if (manifest.status !== "created" || !exactObjectKeys(manifest, ["status", "path", "entries"]) || typeof manifest.path !== "string" || !isAbsolute(manifest.path) || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_PROMOTION_SCAN_ENTRIES) {
    throw new Error(`invalid ${field} manifest`);
  }
  const entries = manifest.entries.map((value, index): PromotionArtifactEntry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${field} manifest entry ${index}`);
    const entry = value as Record<string, unknown>;
    if (!exactObjectKeys(entry, ["rel", "dev", "ino", "state"]) || typeof entry.rel !== "string" || (entry.rel !== "." && !isSafePromotionRelativePath(entry.rel)) || !Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)) {
      throw new Error(`invalid ${field} manifest entry ${index}`);
    }
    let state: PromotionEntryState;
    const raw = entry.state as Record<string, unknown> | null;
    if (raw?.type === "directory" && exactObjectKeys(raw, ["type", "mode"]) && Number.isInteger(raw.mode) && Number(raw.mode) >= 0 && Number(raw.mode) <= 0o777) {
      state = { type: "directory", mode: Number(raw.mode) };
    } else {
      state = parsePromotionJournalState(entry.state, entry.rel, "artifact");
      if (!isMaterializedPromotionState(state)) throw new Error(`invalid ${field} manifest state ${index}`);
    }
    return { rel: entry.rel, dev: Number(entry.dev), ino: Number(entry.ino), state };
  });
  if (entries.length === 0 || entries[0]?.rel !== "." || new Set(entries.map((entry) => entry.rel)).size !== entries.length) throw new Error(`invalid ${field} manifest entries`);
  return { status: "created", path: manifest.path, entries };
}


export async function writePromotionJournal(binding: PromotionJournalBinding, journal: Record<string, unknown>): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(journal, null, 2));
  binding.journalFile = await boundPromotionWriteFile({
    root: binding.directory.path,
    rootIdentity: promotionIdentityOf(binding.directory),
    components: ["journal.json"],
    parentIdentity: promotionIdentityOf(binding.directory),
    expectedDestination: binding.journalFile ?? { state: { type: "missing" } },
    content: bytes,
    mode: 0o600,
  });
}


let promotionRecoveryTestHook: PromotionRecoveryTestHook | null = null;


/** Test-only deterministic interleaving seam; never exposed through IPC. */
export function setPromotionRecoveryTestHookForTest(hook: PromotionRecoveryTestHook | null): void {
  promotionRecoveryTestHook = hook;
}


export async function runPromotionRecoveryTestHook(stage: "after-journal-validation", journalDir: string): Promise<void> {
  await promotionRecoveryTestHook?.(stage, journalDir);
}


export type PromotionRollbackTemp =
  | { status: "planned"; rel: string; path: string; parent: string; parentDev: number; parentIno: number }
  | { status: "created"; rel: string; path: string; parent: string; parentDev: number; parentIno: number; dev: number; ino: number; state: PromotionEntryState };


function parsePromotionJournalState(value: unknown, rel: string, position: string): PromotionEntryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${position}-state at ${rel}`);
  const state = value as Record<string, unknown>;
  if (state.type === "missing" && exactObjectKeys(state, ["type"])) return { type: "missing" };
  if (
    state.type === "file"
    && exactObjectKeys(state, ["type", "mode", "hash"])
    && Number.isInteger(state.mode)
    && Number(state.mode) >= 0
    && Number(state.mode) <= 0o777
    && typeof state.hash === "string"
    && SHA256_HEX.test(state.hash)
  ) {
    return { type: "file", mode: Number(state.mode), hash: state.hash };
  }
  if (state.type === "symlink" && exactObjectKeys(state, ["type", "target"]) && typeof state.target === "string" && !state.target.includes("\0")) {
    return { type: "symlink", target: state.target };
  }
  throw new Error(`invalid ${position}-state at ${rel}`);
}


export function validatePromotionJournalPaths(journal: Record<string, unknown>): PromotionJournalPath[] {
  if (!Array.isArray(journal.paths) || journal.paths.length > 2000) throw new Error("invalid promotion journal paths");
  const seen = new Set<string>();
  return journal.paths.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid promotion path record ${index}`);
    const record = value as Record<string, unknown>;
    const current = exactObjectKeys(record, ["rel", "kind", "beforeHash", "afterHash", "beforeExists", "beforeState", "afterState"]);
    const currentWithRetained = exactObjectKeys(record, ["rel", "kind", "beforeHash", "afterHash", "beforeExists", "beforeState", "afterState", "retainedName"]);
    const currentWithBeforeImage = exactObjectKeys(record, ["rel", "kind", "beforeHash", "afterHash", "beforeExists", "beforeState", "afterState", "beforeImageIdentity", "beforeImageSize"]);
    const currentWithRetainedBeforeImage = exactObjectKeys(record, ["rel", "kind", "beforeHash", "afterHash", "beforeExists", "beforeState", "afterState", "retainedName", "beforeImageIdentity", "beforeImageSize"]);
    if (!current && !currentWithRetained && !currentWithBeforeImage && !currentWithRetainedBeforeImage) throw new Error(`invalid promotion path schema ${index}`);
    if (
      typeof record.rel !== "string"
      || !isSafePromotionRelativePath(record.rel)
      || (record.kind !== "write" && record.kind !== "delete")
      || typeof record.beforeHash !== "string"
      || !SHA256_HEX.test(record.beforeHash)
      || typeof record.afterHash !== "string"
      || !SHA256_HEX.test(record.afterHash)
      || typeof record.beforeExists !== "boolean"
    ) {
      throw new Error(`invalid promotion path fields ${index}`);
    }
    if (record.retainedName !== undefined && (typeof record.retainedName !== "string" || !record.retainedName.startsWith(".termina-promotion-retained-") || !record.retainedName.endsWith(".tmp") || record.retainedName.includes("/") || record.retainedName.includes("\\"))) {
      throw new Error(`invalid promotion retained name ${index}`);
    }
    let beforeImageIdentity: PromotionFsIdentity | undefined;
    if (record.beforeImageIdentity !== undefined) {
      const identity = record.beforeImageIdentity as Record<string, unknown> | null;
      if (!identity || typeof identity !== "object" || Array.isArray(identity) || Object.keys(identity).length !== 2 || typeof identity.dev !== "string" || !/^\d+$/.test(identity.dev) || typeof identity.ino !== "string" || !/^\d+$/.test(identity.ino)) {
        throw new Error(`invalid before-image identity ${index}`);
      }
      beforeImageIdentity = { dev: identity.dev, ino: identity.ino };
    }
    let beforeImageSize: string | undefined;
    if (record.beforeImageSize !== undefined) {
      if (typeof record.beforeImageSize !== "string" || !/^\d+$/.test(record.beforeImageSize)) throw new Error(`invalid before-image size ${index}`);
      beforeImageSize = record.beforeImageSize;
    }
    if (seen.has(record.rel)) throw new Error(`duplicate promotion path: ${record.rel}`);
    seen.add(record.rel);

    const beforeState = parsePromotionJournalState(record.beforeState, record.rel, "before");
    const afterState = parsePromotionJournalState(record.afterState, record.rel, "after");
    if (!isRestorablePromotionState(beforeState) || !isRestorablePromotionState(afterState)) {
      throw new Error(`unsupported promotion state at ${record.rel}`);
    }
    if ((beforeState.type !== "missing") !== record.beforeExists || promotionStateHash(beforeState) !== record.beforeHash) {
      throw new Error(`inconsistent before-state at ${record.rel}`);
    }
    if (record.kind === "write" && !isMaterializedPromotionState(afterState)) throw new Error(`invalid write after-state at ${record.rel}`);
    if (record.kind === "delete" && afterState.type !== "missing") throw new Error(`invalid delete after-state at ${record.rel}`);
    if (promotionStateHash(afterState) !== record.afterHash || (record.kind === "delete" && record.afterHash !== EMPTY_PROMOTION_HASH)) {
      throw new Error(`inconsistent after-state at ${record.rel}`);
    }
    return {
      rel: record.rel,
      kind: record.kind,
      beforeHash: record.beforeHash,
      afterHash: record.afterHash,
      beforeExists: record.beforeExists,
      retainedName: typeof record.retainedName === "string" ? record.retainedName : undefined,
      beforeImageIdentity,
      beforeImageSize,
      beforeState,
      afterState,
    };
  });
}


export function validatePromotionRollbackTemps(journal: Record<string, unknown>): PromotionRollbackTemp[] {
  if (journal.rollbackTemps === undefined) return [];
  if (!Array.isArray(journal.rollbackTemps) || journal.rollbackTemps.length > 2000) throw new Error("invalid promotion rollback temps");
  return journal.rollbackTemps.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid rollback temp ${index}`);
    const record = value as Record<string, unknown>;
    const planned = record.status === "planned" && exactObjectKeys(record, ["status", "rel", "path", "parent", "parentDev", "parentIno"]);
    const created = record.status === "created" && exactObjectKeys(record, ["status", "rel", "path", "parent", "parentDev", "parentIno", "dev", "ino", "state"]);
    if (
      (!planned && !created)
      || typeof record.rel !== "string"
      || !isSafePromotionRelativePath(record.rel)
      || typeof record.path !== "string"
      || !isAbsolute(record.path)
      || typeof record.parent !== "string"
      || !isAbsolute(record.parent)
      || dirname(record.path) !== record.parent
      || !basename(record.path).startsWith(".termina-promotion-")
      || !basename(record.path).endsWith(".tmp")
      || !Number.isSafeInteger(record.parentDev)
      || !Number.isSafeInteger(record.parentIno)
    ) {
      throw new Error(`invalid rollback temp fields ${index}`);
    }
    const base = { status: record.status, rel: record.rel, path: record.path, parent: record.parent, parentDev: Number(record.parentDev), parentIno: Number(record.parentIno) };
    if (planned) return base as PromotionRollbackTemp;
    if (!Number.isSafeInteger(record.dev) || !Number.isSafeInteger(record.ino)) throw new Error(`invalid rollback temp identity ${index}`);
    const state = parsePromotionJournalState(record.state, record.rel, "before");
    if (!isMaterializedPromotionState(state)) throw new Error(`invalid rollback temp state ${index}`);
    return { ...base, status: "created", dev: Number(record.dev), ino: Number(record.ino), state };
  });
}


export function validatePromotionJournalHeader(journal: Record<string, unknown>, primaryRoot: string): void {
  if (!isAbsolute(primaryRoot) || journal.primaryRoot !== primaryRoot) throw new Error("invalid promotion primary root");
  if (journal.phase !== "prepared" && journal.phase !== "applying" && journal.phase !== "applied") throw new Error("invalid active promotion phase");
  // Older journals may still record engine "pi"; accept that at this boundary only.
  if (journal.engine !== undefined && journal.engine !== "pi" && journal.engine !== "core") throw new Error("invalid promotion engine");
  for (const field of ["stagedSession", "installedSession", "installedSessionTemp"] as const) {
    if (journal[field] !== undefined && journal[field] !== null && typeof journal[field] !== "string") {
      throw new Error(`invalid promotion ${field}`);
    }
  }
  if (typeof journal.installedSessionTemp === "string") {
    if (
      typeof journal.installedSession !== "string"
      || dirname(journal.installedSessionTemp) !== dirname(journal.installedSession)
      || basename(journal.installedSessionTemp) !== `.${basename(journal.installedSession)}.tmp`
    ) {
      throw new Error("invalid promotion installedSessionTemp");
    }
  }
  const installedManifest = parsePromotionArtifactManifest(journal.installedSessionManifest, "installedSession");
  const tempManifest = parsePromotionArtifactManifest(journal.installedSessionTempManifest, "installedSessionTemp");
  if ((typeof journal.installedSession === "string") !== Boolean(installedManifest)) throw new Error("installed session is missing its identity manifest");
  if ((typeof journal.installedSessionTemp === "string") !== Boolean(tempManifest)) throw new Error("installed session temp is missing its identity manifest");
}
