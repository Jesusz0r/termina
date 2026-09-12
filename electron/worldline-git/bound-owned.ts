/**
 * App-owned bound entries.
 *
 * Owns owned directory/entry bind/remove and bounded owned writes.
 * Split from electron/worldline-git.ts (issue #38).
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { boundPromotionCreateDirectory, boundPromotionOpenDirectory, boundPromotionReadFile, boundPromotionRemoveTree, boundPromotionWriteFile } from "./bound-promotion.js";
import type { BoundPromotionExpectedLeaf, BoundPromotionExpectedMissing, PromotionFsIdentity } from "./bound-promotion.js";


const NON_PRIVATE_PROMOTION_READ = "promotion read file is not a bounded private regular file";


/**
 * Authenticate the leaf that a bound write will replace. A missing path
 * becomes an explicit missing expectation. A leftover group-readable
 * file (from an older pathname write) is removed through the bound
 * parent so the create path can mint a private 0600 leaf.
 */
async function expectedDestinationForBoundWrite(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
  components: string[];
  parentIdentity: PromotionFsIdentity;
  maxBytes?: number;
  mode?: number;
}): Promise<BoundPromotionExpectedLeaf | BoundPromotionExpectedMissing> {
  try {
    const current = await boundPromotionReadFile({
      root: options.root,
      rootIdentity: options.rootIdentity,
      components: options.components,
      parentIdentity: options.parentIdentity,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
    let mode = options.mode ?? 0o600;
    try {
      mode = lstatSync(join(options.root, ...options.components)).mode & 0o777;
    } catch {
      /* Native read authenticated the existing leaf; keep the safe default. */
    }
    return {
      identity: current.identity,
      state: {
        type: "file",
        mode,
        size: String(current.content.byteLength),
        sha256: createHash("sha256").update(current.content).digest("hex"),
      },
    };
  } catch (error) {
    const path = join(options.root, ...options.components);
    try {
      lstatSync(path);
    } catch (probeError) {
      if (probeError && typeof probeError === "object" && "code" in probeError && probeError.code === "ENOENT") {
        return { state: { type: "missing" } };
      }
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message !== NON_PRIVATE_PROMOTION_READ) throw error;
    const binding = await bindOwnedEntry(path, options.parentIdentity);
    await removeBoundOwnedEntry({ binding });
    return { state: { type: "missing" } };
  }
}


/**
 * Replace one small private file below an already-bound directory.  The
 * existing leaf is authenticated by the native read before the write; a
 * missing leaf is passed as an explicit missing expectation.  This keeps
 * mailbox/provenance bookkeeping on the same descriptor-bound owner as
 * evidence files instead of falling back to a pathname write.
 */
export async function writeBoundOwnedFile(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
  components: string[];
  parentIdentity: PromotionFsIdentity;
  content: Buffer;
  mode?: number;
  maxBytes?: number;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<BoundPromotionExpectedLeaf> {
  const expected = await expectedDestinationForBoundWrite(options);
  return boundPromotionWriteFile({
    root: options.root,
    rootIdentity: options.rootIdentity,
    components: options.components,
    parentIdentity: options.parentIdentity,
    expectedDestination: expected,
    content: options.content,
    mode: options.mode ?? 0o600,
    ...(options.testHook ? { testHook: options.testHook } : {}),
  });
}


/**
 * Write one small JSON bookkeeping file through an identity-bound root. The
 * native write is deliberately direct: a crash can leave malformed JSON, but
 * the next reader rebuilds it fail-closed. The old leaf identity and content
 * hash are supplied when replacing an existing file so a root/leaf ABA cannot
 * redirect the write to a pathname replacement.
 */
export async function boundPromotionWriteJsonFile(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
  components: string[];
  parentIdentity: PromotionFsIdentity;
  value: unknown;
  maxBytes: number;
  mode?: number;
}): Promise<BoundPromotionExpectedLeaf> {
  const content = Buffer.from(JSON.stringify(options.value));
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 || content.byteLength > options.maxBytes) {
    throw new Error("bound promotion JSON exceeds its byte budget");
  }
  const expected = await expectedDestinationForBoundWrite({
    root: options.root,
    rootIdentity: options.rootIdentity,
    components: options.components,
    parentIdentity: options.parentIdentity,
    maxBytes: options.maxBytes,
    mode: options.mode,
  });
  return boundPromotionWriteFile({
    root: options.root,
    rootIdentity: options.rootIdentity,
    components: options.components,
    parentIdentity: options.parentIdentity,
    expectedDestination: expected,
    content,
    mode: options.mode ?? 0o600,
  });
}


/**
 * Provenance for one app-owned directory created below a trusted parent.
 * Cleanup retains both identities so a parent or leaf replacement cannot be
 * mistaken for the directory that the owner created.
 */
export interface BoundOwnedDirectory {
  path: string;
  parentPath: string;
  identity: PromotionFsIdentity;
  parentIdentity: PromotionFsIdentity;
}


/** Provenance for one app-owned leaf below a retained directory. */
export interface BoundOwnedEntry {
  path: string;
  parentPath: string;
  identity: PromotionFsIdentity;
  parentIdentity: PromotionFsIdentity;
  kind: "file" | "symlink";
}


/** Create an owned directory atomically below a bound parent. */
export async function createOwnedDirectory(
  parentPath: string,
  parentIdentity: PromotionFsIdentity,
  prefix: string,
  testHook?: { stage: string; readyPath: string; releasePath: string },
): Promise<BoundOwnedDirectory> {
  const name = `${prefix}${randomUUID()}`;
  const identity = await boundPromotionCreateDirectory({
    root: parentPath,
    rootIdentity: parentIdentity,
    components: [name],
    parentIdentity,
    requireMissing: true,
    ...(testHook ? { testHook } : {}),
  });
  return {
    path: join(parentPath, name),
    parentPath,
    identity,
    parentIdentity,
  };
}


/** Bind an existing app-owned regular-file or symlink leaf. */
export async function bindOwnedEntry(
  path: string,
  expectedParentIdentity?: PromotionFsIdentity,
  expectedIdentity?: PromotionFsIdentity,
): Promise<BoundOwnedEntry> {
  const parentPath = dirname(path);
  const parentExpected = expectedParentIdentity ?? (() => {
    const metadata = lstatSync(parentPath, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("owned entry parent is not a real directory");
    return { dev: String(metadata.dev), ino: String(metadata.ino) };
  })();
  const parentIdentity = await boundPromotionOpenDirectory({
    path: parentPath,
    expectedIdentity: parentExpected,
  });
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile() && !metadata.isSymbolicLink()) throw new Error("owned entry is not a regular file or symlink");
  const identity = { dev: String(metadata.dev), ino: String(metadata.ino) };
  if (expectedIdentity && (identity.dev !== expectedIdentity.dev || identity.ino !== expectedIdentity.ino)) {
    throw new Error("owned entry identity changed while binding");
  }
  const verifiedParent = await boundPromotionOpenDirectory({
    path: parentPath,
    expectedIdentity: parentIdentity,
  });
  if (verifiedParent.dev !== parentIdentity.dev || verifiedParent.ino !== parentIdentity.ino) {
    throw new Error("owned entry parent identity changed while binding");
  }
  return {
    path,
    parentPath,
    identity,
    parentIdentity: verifiedParent,
    kind: metadata.isSymbolicLink() ? "symlink" : "file",
  };
}


/** Bind an existing app-owned directory and its immediate parent. */
export async function bindOwnedDirectory(
  path: string,
  expectedParentIdentity?: PromotionFsIdentity,
): Promise<BoundOwnedDirectory> {
  const parentPath = dirname(path);
  const pathIdentity = (candidate: string, field: string): PromotionFsIdentity => {
    const metadata = lstatSync(candidate, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${field} is not a real directory`);
    return { dev: String(metadata.dev), ino: String(metadata.ino) };
  };
  const parentExpected = expectedParentIdentity ?? pathIdentity(parentPath, "owned directory parent");
  const parentIdentity = await boundPromotionOpenDirectory({
    path: parentPath,
    expectedIdentity: parentExpected,
  });
  const identity = await boundPromotionOpenDirectory({
    path,
    expectedIdentity: pathIdentity(path, "owned directory"),
  });
  const verifiedParent = await boundPromotionOpenDirectory({
    path: parentPath,
    expectedIdentity: parentIdentity,
  });
  if (verifiedParent.dev !== parentIdentity.dev || verifiedParent.ino !== parentIdentity.ino) {
    throw new Error("owned directory parent identity changed while binding");
  }
  return { path, parentPath, identity, parentIdentity: verifiedParent };
}


/** Remove an owned directory only through its identity-bound parent. */
export async function removeBoundOwnedDirectory(options: {
  binding: BoundOwnedDirectory;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<void> {
  const { binding } = options;
  const expectedParent = { dev: binding.parentIdentity.dev, ino: binding.parentIdentity.ino };
  let parent: PromotionFsIdentity;
  try {
    parent = await boundPromotionOpenDirectory({
      path: binding.parentPath,
      expectedIdentity: expectedParent,
      ...(binding.parentIdentity.capability ? { capability: binding.parentIdentity.capability } : {}),
    });
  } catch {
    // A native core restart discards in-memory capabilities.  Rebind only by
    // the persisted identity; a replacement parent still fails closed.
    parent = await boundPromotionOpenDirectory({ path: binding.parentPath, expectedIdentity: expectedParent });
  }
  const leafName = basename(binding.path);
  if (!leafName || leafName === "." || leafName === ".." || leafName.includes("/") || leafName.includes("\\")) {
    throw new Error("owned directory leaf name is invalid");
  }
  await boundPromotionRemoveTree({
    root: binding.parentPath,
    rootIdentity: parent,
    components: [leafName],
    parentIdentity: parent,
    expectedIdentity: { dev: binding.identity.dev, ino: binding.identity.ino },
    ...(options.testHook ? { testHook: options.testHook } : {}),
  });
}


/** Remove an app-owned leaf only through its identity-bound parent. */
export async function removeBoundOwnedEntry(options: {
  binding: BoundOwnedEntry;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<void> {
  const { binding } = options;
  const expectedParent = { dev: binding.parentIdentity.dev, ino: binding.parentIdentity.ino };
  let parent: PromotionFsIdentity;
  try {
    parent = await boundPromotionOpenDirectory({
      path: binding.parentPath,
      expectedIdentity: expectedParent,
      ...(binding.parentIdentity.capability ? { capability: binding.parentIdentity.capability } : {}),
    });
  } catch {
    parent = await boundPromotionOpenDirectory({ path: binding.parentPath, expectedIdentity: expectedParent });
  }
  const leafName = basename(binding.path);
  if (!leafName || leafName === "." || leafName === ".." || leafName.includes("/") || leafName.includes("\\")) {
    throw new Error("owned entry leaf name is invalid");
  }
  await boundPromotionRemoveTree({
    root: binding.parentPath,
    rootIdentity: parent,
    components: [leafName],
    parentIdentity: parent,
    expectedIdentity: { dev: binding.identity.dev, ino: binding.identity.ino },
    ...(options.testHook ? { testHook: options.testHook } : {}),
  });
}
