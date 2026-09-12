/**
 * Descriptor-bound promotion directories.
 *
 * Owns bound root ensure/probe/materialize and provenance. Split from
 * promotion-recovery.ts (issue #38).
 */
import { boundPromotionCopyFile, boundPromotionCreateDirectory, boundPromotionEnsureDirectory, boundPromotionOpenDirectory, boundPromotionPrepareDirectory, boundPromotionReadFile, type PromotionFsIdentity } from "../../worldline-git.js";
import { promotionIdentityOf, refreshBoundPromotionDirectory } from "../bindings.js";
import { errnoCode } from "../guards.js";
import { MAX_AGENT_RESOURCE_BYTES, MAX_PROMOTION_SCAN_DEPTH, MAX_PROMOTION_SCAN_WORK_BYTES } from "../limits.js";
import { type BoundPromotionDirectory, type ComparisonState, type PromotionDirectoryPlan, type PromotionRootProvenance } from "../types.js";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat as lstatPath, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { sha256Hex } from "./primitives.js";


const PROMOTION_ROOT_PROVENANCE_VERSION = 1;

const PROMOTION_ROOT_PROVENANCE_PREFIX = ".termina-promotion-root-";

const PROMOTION_ROOT_PROVENANCE_MAX_BYTES = 4096;


/** Rebind every retained comparison root after a native core restart. */
export async function refreshComparisonBindings(cmp: ComparisonState): Promise<void> {
  if (cmp.rootBinding) {
    cmp.rootBinding = await refreshBoundPromotionDirectory(cmp.rootBinding);
    cmp.rootIdentity = promotionIdentityOf(cmp.rootBinding);
  }
  if (cmp.templateBinding) {
    cmp.templateBinding = await refreshBoundPromotionDirectory(cmp.templateBinding);
    cmp.templateIdentity = promotionIdentityOf(cmp.templateBinding);
  }
  if (cmp.profilesBinding) cmp.profilesBinding = await refreshBoundPromotionDirectory(cmp.profilesBinding);
  if (cmp.sessionWorkspaceBinding) cmp.sessionWorkspaceBinding = await refreshBoundPromotionDirectory(cmp.sessionWorkspaceBinding);
  for (const cand of cmp.candidates.values()) {
    if (cand.rootBinding) {
      cand.rootBinding = await refreshBoundPromotionDirectory(cand.rootBinding);
      cand.rootIdentity = promotionIdentityOf(cand.rootBinding);
    }
    for (const key of ["supportBinding", "homeBinding", "sessionBinding", "eventsBinding", "tmpBinding", "cacheBinding"] as const) {
      const binding = cand[key];
      if (binding) cand[key] = await refreshBoundPromotionDirectory(binding);
    }
  }
}


export function assertBoundPromotionDirectory(bound: BoundPromotionDirectory): void {
  const info = lstatSync(bound.path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== bound.dev || String(info.ino) !== bound.ino) throw new Error(`promotion journal directory changed: ${bound.path}`);
}


/** Create a new template root below the natively allocated comparison. */
export async function createSnapshotTemplateDirectory(cmp: ComparisonState): Promise<BoundPromotionDirectory> {
  const root = cmp.rootBinding;
  if (!root) throw new Error("comparison root is not natively bound");
  const identity = await boundPromotionCreateDirectory({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: ["template"],
    parentIdentity: promotionIdentityOf(root),
    requireMissing: true,
  });
  cmp.templateIdentity = identity;
  const binding = { path: join(root.path, "template"), dev: identity.dev, ino: identity.ino, capability: identity.capability };
  cmp.templateBinding = binding;
  return binding;
}


/** Build a descriptor-bound parent proof for a first root bind. The native
 * opener validates this parent identity before opening or creating the leaf;
 * the mutable leaf itself is never used as its own trust anchor. */
async function trustedPromotionParent(path: string, field: string): Promise<{ path: string; identity: PromotionFsIdentity; name: string }> {
  const parentPath = dirname(path);
  const name = basename(path);
  if (!name || name === "." || name === ".." || name.includes("\0")) throw new Error(`${field} has an invalid leaf name`);
  const info = await lstatPath(parentPath, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${field} parent is not a private directory`);
  return { path: parentPath, identity: { dev: String(info.dev), ino: String(info.ino) }, name };
}


/**
 * Establish a retained-root parent from the nearest existing ancestor.  The
 * ancestor identity is only a discovery hint; native prepare reopens it with
 * that exact identity and creates the missing tail descriptor-relatively.
 * This preserves recursive parent creation without making a mutable pathname
 * the trust anchor for the retained root transaction.
 */
async function ensureRetainedRootParent(path: string, field: string): Promise<BoundPromotionDirectory> {
  let current = resolve(path);
  const missing: string[] = [];
  let workBytes = Buffer.byteLength(current, "utf8");
  if (workBytes > MAX_PROMOTION_SCAN_WORK_BYTES) throw new Error(`${field} parent path exceeds its bounded work budget`);
  while (true) {
    let info;
    try {
      info = await lstatPath(current, { bigint: true });
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error(`${field} parent has no existing trusted ancestor`);
      if (missing.length >= MAX_PROMOTION_SCAN_DEPTH) throw new Error(`${field} parent exceeds its ${MAX_PROMOTION_SCAN_DEPTH}-level depth bound`);
      const component = basename(current);
      const componentBytes = Buffer.byteLength(component, "utf8");
      if (workBytes > MAX_PROMOTION_SCAN_WORK_BYTES - componentBytes) throw new Error(`${field} parent exceeds its bounded work budget`);
      workBytes += componentBytes;
      missing.unshift(component);
      current = parent;
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${field} parent is not an app-owned directory`);
    const canonical = await realpath(current);
    const ancestor: BoundPromotionDirectory = {
      path: canonical,
      dev: String(info.dev),
      ino: String(info.ino),
    };
    const probe = await boundPromotionPrepareDirectory({
      root: ancestor.path,
      rootIdentity: promotionIdentityOf(ancestor),
      components: missing,
      allowMissing: true,
    });
    let parentBinding: BoundPromotionDirectory;
    if (probe.identity) {
      parentBinding = {
        path: join(ancestor.path, ...missing),
        dev: probe.identity.dev,
        ino: probe.identity.ino,
        capability: probe.identity.capability,
      };
    } else {
      if (probe.missingAt === null) throw new Error(`${field} parent identity is unavailable`);
      const materialized = await boundPromotionPrepareDirectory({
        root: ancestor.path,
        rootIdentity: promotionIdentityOf(ancestor),
        components: missing,
        createMissing: true,
        expectedMissingAt: probe.missingAt,
        expectedChain: probe.chain,
      });
      if (!materialized.identity) throw new Error(`${field} parent could not be materialized`);
      parentBinding = {
        path: join(ancestor.path, ...missing),
        dev: materialized.identity.dev,
        ino: materialized.identity.ino,
        capability: materialized.identity.capability,
      };
    }
    return parentBinding;
  }
}


/** Store root provenance outside, never inside, the mutable root leaf. */
function promotionRootProvenancePath(path: string, provenanceDirectory?: BoundPromotionDirectory): string {
  const digest = createHash("sha256").update(path).digest("hex");
  return join(provenanceDirectory?.path ?? dirname(path), `${PROMOTION_ROOT_PROVENANCE_PREFIX}${digest}.json`);
}


function promotionRootProvenanceIdentity(value: unknown, field: string): { dev: string; ino: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${field}`);
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || typeof record.dev !== "string"
    || !/^\d+$/.test(record.dev)
    || typeof record.ino !== "string"
    || !/^\d+$/.test(record.ino)
  ) throw new Error(`invalid ${field}`);
  return { dev: record.dev, ino: record.ino };
}


async function readPromotionRootProvenance(
  absolute: string,
  parent: { path: string; identity: PromotionFsIdentity; name: string },
  field: string,
  provenanceDirectory?: BoundPromotionDirectory,
): Promise<PromotionRootProvenance | null> {
  const provenancePath = promotionRootProvenancePath(absolute, provenanceDirectory);
  let info;
  try {
    info = await lstatPath(provenancePath, { bigint: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0n || info.size > BigInt(PROMOTION_ROOT_PROVENANCE_MAX_BYTES)) {
    throw new Error(`${field} root provenance is not a bounded regular file`);
  }
  const provenanceParent = provenanceDirectory ?? parent;
  const provenanceParentIdentity = provenanceDirectory
    ? promotionIdentityOf(provenanceDirectory)
    : parent.identity;
  const read = await boundPromotionReadFile({
    root: provenanceParent.path,
    rootIdentity: provenanceParentIdentity,
    components: [basename(provenancePath)],
    parentIdentity: provenanceParentIdentity,
    expectedIdentity: { dev: String(info.dev), ino: String(info.ino) },
    maxBytes: PROMOTION_ROOT_PROVENANCE_MAX_BYTES,
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.content)) as unknown;
  } catch {
    throw new Error(`${field} root provenance is malformed`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} root provenance is malformed`);
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4
    || record.version !== PROMOTION_ROOT_PROVENANCE_VERSION
    || record.path !== absolute
  ) throw new Error(`${field} root provenance is malformed`);
  const parentIdentity = promotionRootProvenanceIdentity(record.parent, `${field} root provenance parent`);
  const rootIdentity = promotionRootProvenanceIdentity(record.root, `${field} root provenance root`);
  if (parentIdentity.dev !== parent.identity.dev || parentIdentity.ino !== parent.identity.ino) {
    throw new Error(`${field} root provenance parent identity changed`);
  }
  return { version: 1, path: absolute, parent: parentIdentity, root: rootIdentity };
}


/** Create a directory component through the native descriptor boundary. */
export async function ensureBoundChildDirectory(parent: BoundPromotionDirectory, name: string, requireMissing = false): Promise<BoundPromotionDirectory> {
  const identity = await boundPromotionCreateDirectory({
    root: parent.path,
    rootIdentity: promotionIdentityOf(parent),
    components: [name],
    parentIdentity: promotionIdentityOf(parent),
    requireMissing,
  });
  return { path: join(parent.path, name), dev: identity.dev, ino: identity.ino, capability: identity.capability };
}


/** Copy one optional private resource through both bound parent descriptors. */
export async function copyBoundPrivateFile(
  sourcePath: string,
  destination: BoundPromotionDirectory,
  name: string,
): Promise<void> {
  const sourceInfo = await lstatPath(sourcePath, { bigint: true });
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("private resource is not a regular file");
  const sourceParentPath = dirname(sourcePath);
  const sourceParentInfo = await lstatPath(sourceParentPath, { bigint: true });
  if (!sourceParentInfo.isDirectory() || sourceParentInfo.isSymbolicLink()) throw new Error("private resource parent is not a real directory");
  const sourceParent = await boundPromotionOpenDirectory({
    path: sourceParentPath,
    expectedIdentity: { dev: String(sourceParentInfo.dev), ino: String(sourceParentInfo.ino) },
  });
  const source = await boundPromotionReadFile({
    root: sourceParentPath,
    rootIdentity: sourceParent,
    components: [basename(sourcePath)],
    parentIdentity: sourceParent,
    maxBytes: MAX_AGENT_RESOURCE_BYTES,
  });
  if (source.content.byteLength !== Number(sourceInfo.size)) throw new Error("private resource changed while reading");
  await boundPromotionCopyFile({
    sourceRoot: sourceParentPath,
    sourceRootIdentity: sourceParent,
    sourceComponents: [basename(sourcePath)],
    sourceParentIdentity: sourceParent,
    expectedSource: {
      identity: source.identity,
      state: {
        type: "file",
        mode: Number(sourceInfo.mode & 0o777n),
        size: String(source.content.byteLength),
        sha256: sha256Hex(source.content),
      },
    },
    destinationRoot: destination.path,
    destinationRootIdentity: promotionIdentityOf(destination),
    destinationComponents: [name],
    destinationParentIdentity: promotionIdentityOf(destination),
  });
}


/** Create every missing tail component below a read-only discovered root. */
export async function ensureBoundDirectory(
  path: string,
  field: string,
  provenanceDirectory?: BoundPromotionDirectory,
  options: { initialIdentity?: PromotionFsIdentity } = {},
): Promise<BoundPromotionDirectory> {
  const requested = resolve(path);
  const canonicalParent = await filesystemCanonicalPath(dirname(requested));
  const absolute = join(canonicalParent, basename(requested));
  if (!isAbsolute(absolute)) throw new Error(`${field} must be absolute`);
  const trustedParent = await trustedPromotionParent(absolute, field);
  // A few narrow owner-level harnesses intentionally use the same directory
  // for worlds and primary roots. In that degenerate case the provenance
  // record cannot live inside its own mutable root; use the trusted parent
  // boundary (the normal worlds-root bootstrap path) instead.
  const rootProvenanceDirectory = provenanceDirectory && resolve(provenanceDirectory.path) !== absolute
    ? provenanceDirectory
    : undefined;
  const provenance = await readPromotionRootProvenance(absolute, trustedParent, field, rootProvenanceDirectory);
  if (provenance) {
    const identity = await boundPromotionEnsureDirectory({
      path: absolute,
      expectedIdentity: provenance.root,
    }).catch((error) => {
      throw new Error(`${field} could not be rebound natively: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (identity.dev !== provenance.root.dev || identity.ino !== provenance.root.ino) {
      throw new Error(`${field} root identity changed during rebind`);
    }
    return { path: absolute, dev: identity.dev, ino: identity.ino, capability: identity.capability };
  }
  const provenancePath = promotionRootProvenancePath(absolute, rootProvenanceDirectory);
  const provenanceParent = rootProvenanceDirectory ?? trustedParent;
  const provenanceParentIdentity = rootProvenanceDirectory
    ? promotionIdentityOf(rootProvenanceDirectory)
    : trustedParent.identity;
  const identity = await boundPromotionEnsureDirectory({
    path: absolute,
    ...(options.initialIdentity ? { expectedIdentity: options.initialIdentity } : {}),
    trustedParent,
    provenance: {
      name: basename(provenancePath),
      parent: {
        path: provenanceParent.path,
        identity: provenanceParentIdentity,
      },
    },
  }).catch((error) => {
    throw new Error(`${field} could not be bound natively: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { path: absolute, dev: identity.dev, ino: identity.ino, capability: identity.capability };
}


export async function existingPromotionDirectoryIdentity(path: string, field: string): Promise<PromotionFsIdentity | undefined> {
  try {
    const info = await lstatPath(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${field} is not a real directory`);
    return { dev: String(info.dev), ino: String(info.ino) };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return undefined;
    throw error;
  }
}


/**
 * Bind the retained-session root through the native create/bind transaction.
 * The retained marker is mutable evidence, not provenance: the native
 * operation validates or creates it while the exact parent/leaf descriptors
 * remain open, and persists the external identity record in the same call.
 */
export async function ensureBoundRetainedRoot(
  path: string,
  field: string,
  marker: { name: string; content: Buffer; mode?: number },
  testHook?: { stage: string; readyPath: string; releasePath: string },
): Promise<BoundPromotionDirectory> {
  const requested = resolve(path);
  const parentBinding = await ensureRetainedRootParent(dirname(requested), field);
  const leafName = basename(requested);
  if (!leafName || leafName === "." || leafName === ".." || leafName.includes("\0")) throw new Error(`${field} has an invalid leaf name`);
  const trustedParent = { path: parentBinding.path, identity: promotionIdentityOf(parentBinding), name: leafName };
  const absolute = join(parentBinding.path, leafName);
  if (!isAbsolute(absolute)) throw new Error(`${field} must be absolute`);
  const provenancePath = promotionRootProvenancePath(absolute);
  const provenance = await readPromotionRootProvenance(absolute, trustedParent, field);
  const identity = await boundPromotionEnsureDirectory({
    path: absolute,
    ...(provenance ? { expectedIdentity: provenance.root } : {}),
    trustedParent,
    provenance: {
      name: basename(provenancePath),
      parent: {
        path: trustedParent.path,
        identity: trustedParent.identity,
      },
    },
    marker,
    ...(testHook ? { testHook } : {}),
  }).catch((error) => {
    throw new Error(`${field} could not be bound natively: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (provenance && (identity.dev !== provenance.root.dev || identity.ino !== provenance.root.ino)) {
    throw new Error(`${field} root identity changed during rebind`);
  }
  return { path: absolute, dev: identity.dev, ino: identity.ino, capability: identity.capability };
}


function promotionDirectoryComponents(root: string, target: string, field: string): string[] {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  const rel = relative(rootPath, targetPath);
  if (rel === "" || rel === ".") return [];
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${field} escapes its bound root`);
  const components = rel.split(/[\\/]+/).filter(Boolean);
  if (components.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
    throw new Error(`invalid ${field} components`);
  }
  return components;
}


/** Capture a parent identity from a native descriptor before path preflight. */
export async function probePromotionDirectory(root: BoundPromotionDirectory, target: string, field: string): Promise<PromotionDirectoryPlan> {
  const path = resolve(target);
  const components = promotionDirectoryComponents(root.path, path, field);
  const result = await boundPromotionPrepareDirectory({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components,
    allowMissing: true,
  });
  const prefixLength = result.missingAt ?? components.length;
  if (result.chain.length !== prefixLength) throw new Error(`${field} native identity chain is incomplete`);
  return { path, components, identity: result.identity, missingAt: result.missingAt, prefixIdentities: result.chain };
}


/** Create a previously absent parent only from the trusted native root. */
export async function materializePromotionDirectoryPlan(root: BoundPromotionDirectory, plan: PromotionDirectoryPlan, field: string): Promise<BoundPromotionDirectory> {
  if (plan.identity) return { path: plan.path, dev: plan.identity.dev, ino: plan.identity.ino, capability: plan.identity.capability };
  if (plan.missingAt === null) throw new Error(`${field} has no bound identity`);
  const identity = await boundPromotionPrepareDirectory({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: plan.components,
    createMissing: true,
    expectedMissingAt: plan.missingAt,
    expectedChain: plan.prefixIdentities,
  });
  if (!identity.identity) throw new Error(`${field} was not materialized`);
  return { path: plan.path, dev: identity.identity.dev, ino: identity.identity.ino, capability: identity.identity.capability };
}


/** Resolve/create a relative directory under an already bound directory. */
export async function ensureBoundRelativeDirectory(root: BoundPromotionDirectory, components: string[], field: string): Promise<BoundPromotionDirectory> {
  let current = root;
  for (const name of components) {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error(`invalid ${field} component`);
    current = await ensureBoundChildDirectory(current, name);
  }
  return current;
}


export async function filesystemCanonicalPath(absPath: string): Promise<string> {
  let tail = "";
  let current = absPath;
  while (true) {
    try {
      const canonical = await realpath(current);
      return tail ? join(canonical, tail) : canonical;
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) return absPath;
      tail = tail ? join(basename(current), tail) : basename(current);
      current = parent;
    }
  }
}
