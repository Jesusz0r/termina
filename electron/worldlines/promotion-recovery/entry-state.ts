/**
 * Promotion entry states, before-images, and destinations.
 *
 * Owns entry-state predicates, before-image capture, and destination
 * resolution. Split from promotion-recovery.ts (issue #38).
 */
import { boundPromotionCopyFile, type BoundPromotionExpectedLeaf } from "../../worldline-git.js";
import { promotionIdentityOf } from "../bindings.js";
import { errnoCode, isInside } from "../guards.js";
import { type BoundPromotionDirectory, type CanonicalPath, type PromotionDirectoryPlan, type PromotionEntryState } from "../types.js";
import { constants as fsConstants } from "node:fs";
import { lstat as lstatPath, open as openFile, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ensureBoundRelativeDirectory } from "./bound-dirs.js";
import { isSafePromotionRelativePath, promotionNoFollowFlag, sha256Hex, statIdentityEqual } from "./primitives.js";

type PromotionParentIdentity = { path: string; dev: number; ino: number; capability?: string };


export async function readPromotionEntry(abs: string): Promise<{ state: PromotionEntryState; bytes?: Buffer }> {
  let pathInfo;
  try {
    pathInfo = await lstatPath(abs);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { state: { type: "missing" } };
    throw error;
  }
  if (pathInfo.isSymbolicLink()) {
    const target = await readlink(abs);
    const after = await lstatPath(abs);
    if (!after.isSymbolicLink() || !statIdentityEqual(pathInfo, after)) throw new Error(`filesystem entry changed while reading: ${abs}`);
    return { state: { type: "symlink", target } };
  }
  if (pathInfo.isFile()) {
    const handle = await openFile(abs, fsConstants.O_RDONLY | promotionNoFollowFlag());
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new Error(`filesystem entry changed type while reading: ${abs}`);
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const pathAfter = await lstatPath(abs);
      if (!after.isFile() || !pathAfter.isFile() || !statIdentityEqual(before, after) || before.dev !== pathAfter.dev || before.ino !== pathAfter.ino) {
        throw new Error(`filesystem entry changed while reading: ${abs}`);
      }
      return { state: { type: "file", mode: before.mode & 0o777, hash: sha256Hex(bytes) }, bytes };
    } finally {
      await handle.close();
    }
  }
  if (pathInfo.isDirectory()) return { state: { type: "directory", mode: pathInfo.mode & 0o777 } };
  return { state: { type: "other", mode: pathInfo.mode & 0o777 } };
}


export function promotionStateHash(state: PromotionEntryState): string {
  if (state.type === "file") return state.hash;
  if (state.type === "symlink") return sha256Hex(Buffer.from(state.target));
  return sha256Hex(Buffer.alloc(0));
}


export function isRestorablePromotionState(state: PromotionEntryState): state is Exclude<PromotionEntryState, { type: "directory" | "other" }> {
  return state.type === "missing" || state.type === "file" || state.type === "symlink";
}


export function isMaterializedPromotionState(state: PromotionEntryState): state is Extract<PromotionEntryState, { type: "file" | "symlink" }> {
  return state.type === "file" || state.type === "symlink";
}


export function promotionStatesEqual(actual: PromotionEntryState, expected: PromotionEntryState): boolean {
  if (actual.type !== expected.type) return false;
  if (actual.type === "missing") return true;
  if (actual.type === "file" && expected.type === "file") {
    return actual.hash === expected.hash && (expected.mode === undefined || actual.mode === expected.mode);
  }
  if (actual.type === "symlink" && expected.type === "symlink") return actual.target === expected.target;
  if (actual.type === "directory" && expected.type === "directory") return actual.mode === expected.mode;
  if (actual.type === "other" && expected.type === "other") return actual.mode === expected.mode;
  return false;
}


export async function assertPromotionState(abs: string, expected: PromotionEntryState, message: string): Promise<void> {
  if (!promotionStatesEqual((await readPromotionEntry(abs)).state, expected)) throw new Error(message);
}


export async function copyBoundBeforeImage(
  sourceRoot: BoundPromotionDirectory,
  sourceComponents: string[],
  sourceParent: BoundPromotionDirectory,
  destinationRoot: BoundPromotionDirectory,
  destinationComponents: string[],
  expectedSource: BoundPromotionExpectedLeaf,
): Promise<BoundPromotionExpectedLeaf> {
  const destinationParent = await ensureBoundRelativeDirectory(
    destinationRoot,
    destinationComponents.slice(0, -1),
    "before-image",
  );
  return boundPromotionCopyFile({
    sourceRoot: sourceRoot.path,
    sourceRootIdentity: promotionIdentityOf(sourceRoot),
    sourceComponents,
    sourceParentIdentity: promotionIdentityOf(sourceParent),
    expectedSource,
    destinationRoot: destinationRoot.path,
    destinationRootIdentity: promotionIdentityOf(destinationRoot),
    destinationComponents,
    destinationParentIdentity: promotionIdentityOf(destinationParent),
  });
}


export async function promotionDestination(primaryRoot: string, canonicalRoot: string, rel: string, canonicalPath: CanonicalPath): Promise<string> {
  if (!isAbsolute(primaryRoot) || !isSafePromotionRelativePath(rel)) {
    throw new Error(`promotion path escapes the primary project: ${rel}`);
  }
  const abs = join(primaryRoot, rel);
  if (!isInside(canonicalRoot, await canonicalPath(abs))) {
    throw new Error(`promotion path escapes the primary project: ${rel}`);
  }
  // This rejects stationary symlink escapes for policy/preflight reads. The
  // actual promotion mutation is descriptor-relative in the native core; the
  // path result is never passed to a destructive rm/rename sink.
  return abs;
}


export async function promotionParentIdentity(abs: string, canonicalRoot: string, canonicalPath: CanonicalPath, prebound: PromotionDirectoryPlan): Promise<PromotionParentIdentity> {
  const parent = await canonicalPath(dirname(abs));
  if (!isInside(canonicalRoot, parent)) throw new Error(`promotion parent escapes the primary project: ${abs}`);
  if (resolve(prebound.path) !== resolve(parent)) {
    throw new Error(`promotion parent binding does not match the requested path: ${abs}`);
  }
  const identity = prebound.identity;
  if (!identity) throw new Error(`promotion parent is not present: ${parent}`);
  return { path: parent, dev: Number(identity.dev), ino: Number(identity.ino), capability: identity.capability };
}


export async function boundPromotionExpectedLeaf(abs: string, expected: PromotionEntryState, field: string): Promise<BoundPromotionExpectedLeaf> {
  if (!isMaterializedPromotionState(expected)) throw new Error(`${field} is not a materialized promotion state`);
  const observed = await readPromotionEntry(abs);
  if (!promotionStatesEqual(observed.state, expected)) throw new Error(`${field} changed before native transition`);
  const info = await lstatPath(abs, { bigint: true });
  const identity = { dev: String(info.dev), ino: String(info.ino) };
  if (expected.type === "file") {
    if (!observed.bytes) throw new Error(`${field} file bytes were not read`);
    return {
      identity,
      state: {
        type: "file",
        mode: expected.mode ?? Number(info.mode & 0o777n),
        size: String(observed.bytes.byteLength),
        sha256: expected.hash,
      },
    };
  }
  return { identity, state: { type: "symlink", target: expected.target } };
}


export function promotionDestinationComponents(primaryRoot: string, parent: string, rel: string): string[] {
  const parentRel = relative(primaryRoot, parent);
  const parts = parentRel ? parentRel.split(/[\\/]+/).filter(Boolean) : [];
  const destination = basename(rel);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0")) || !destination || destination === "." || destination === "..") {
    throw new Error(`invalid native promotion destination: ${rel}`);
  }
  return [...parts, destination];
}


export function promotionParentComponents(root: string, parent: string): string[] {
  const parentRel = relative(root, parent);
  if (!parentRel) return [];
  const parts = parentRel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0"))) throw new Error(`invalid native promotion parent: ${parent}`);
  return parts;
}


export function promotionSourceComponents(rel: string): string[] {
  if (!isSafePromotionRelativePath(rel)) throw new Error(`invalid native promotion source: ${rel}`);
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0")) || parts.length === 0) {
    throw new Error(`invalid native promotion source: ${rel}`);
  }
  return parts;
}
