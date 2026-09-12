/**
 * Promotion durability engine (`electron/worldlines/`).
 * Bound-directory IO, comparison manifests, journal validation and
 * rollback, retained roots, recovery, and the promotion transaction.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync } from "node:fs";
import { lstat as lstatPath, open as openFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  boundPromotionCopyFile,
  boundPromotionCreateDirectory,
  boundPromotionCreateSymlink,
  boundPromotionEnsureDirectory,
  boundPromotionInstallDirectory,
  boundPromotionListDirectories,
  boundPromotionOpenDirectory,
  boundPromotionPrepareDirectory,
  boundPromotionTransition,
  boundPromotionWriteFile,
  boundPromotionReadFile,
  disposeWorldlineGitCore,
  readBoundPromotionJournal,
} from "../worldline-git.js";
import { parseSessionBundlePath } from "../../agent-core/session.js";
import {
  MARKER,
  MAX_AGENT_RESOURCE_BYTES,
  MAX_PROMOTION_OPERATION_BYTES,
  MAX_PROMOTION_SCAN_DEPTH,
  MAX_PROMOTION_SCAN_ENTRIES,
  MAX_PROMOTION_SCAN_PENDING,
  MAX_PROMOTION_SCAN_WORK_BYTES,
  MAX_WORLDLINE_FILE_BYTES,
} from "./limits.js";
import type {
  BoundPromotionDirectory,
  ComparisonManifest,
  ComparisonState,
  PromotionArtifactEntry,
  PromotionArtifactManifest,
  PromotionDirectoryPlan,
  PromotionEntryState,
  PromotionJournalBinding,
  PromotionJournalPath,
  PromotionRecoveryContext,
  PromotionRecoveryTestHook,
  PromotionRootProvenance,
  CanonicalPath,
} from "./types.js";
import type { BoundPromotionExpectedLeaf, PromotionFsIdentity } from "../worldline-git.js";
import { boundedWorldlineEntries, parseComparisonManifest } from "./uncertain-comparison.js";
import { errnoCode, isInside } from "./guards.js";
import { promotionIdentityOf, refreshBoundPromotionDirectory } from "./bindings.js";
import {
  promotionJournalAdmissionOwnerFor,
  releasePromotionJournalAdmissionOwner,
} from "./promotion-journal.js";

export function waitBounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolvePromise(undefined);
    }, timeoutMs);
    void promise.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(undefined);
    });
  });
}

export function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("candidate startup was cancelled"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new Error("candidate startup was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        rejectPromise(error);
      },
    );
  });
}

/** Read the process start time without blocking the main process. */
export function readProcessStart(pid: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    try {
      execFile("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
        resolvePromise(error ? null : stdout.trim() || null);
      });
    } catch {
      // A restricted host may reject process inspection synchronously. The
      // caller remains fail-closed (no proven identity means no direct kill).
      resolvePromise(null);
    }
  });
}

/** Check that a pid still names the same process start time. */
export async function processStartMatches(pid: number, lstart: string): Promise<boolean> {
  const current = await readProcessStart(pid);
  return current !== null && current === lstart;
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

let promotionTransactionTail: Promise<void> = Promise.resolve();

/** Serialize every live promotion and startup/project-open recovery in this process. */
export async function withPromotionTransaction<T>(operation: () => Promise<T>): Promise<T> {
  const previous = promotionTransactionTail;
  let release!: () => void;
  promotionTransactionTail = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}


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

function parsePromotionArtifactManifest(value: unknown, field: string): PromotionArtifactManifest | null {
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

const PROMOTION_ROOT_PROVENANCE_VERSION = 1;
const PROMOTION_ROOT_PROVENANCE_PREFIX = ".termina-promotion-root-";
const PROMOTION_ROOT_PROVENANCE_MAX_BYTES = 4096;

export async function writeComparisonManifestBound(
  root: BoundPromotionDirectory,
  manifest: ComparisonManifest,
  expectedDestination: BoundPromotionExpectedLeaf | { state: { type: "missing" } },
): Promise<BoundPromotionExpectedLeaf> {
  return boundPromotionWriteFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: ["manifest.json"],
    parentIdentity: promotionIdentityOf(root),
    expectedDestination,
    content: Buffer.from(JSON.stringify(manifest, null, 2)),
    mode: 0o600,
  });
}

export async function writeComparisonMarkerBound(root: BoundPromotionDirectory): Promise<BoundPromotionExpectedLeaf> {
  return boundPromotionWriteFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: [MARKER],
    parentIdentity: promotionIdentityOf(root),
    expectedDestination: { state: { type: "missing" } },
    content: Buffer.from(randomUUID()),
    mode: 0o600,
  });
}

export async function readComparisonManifestBound(
  root: BoundPromotionDirectory,
  expected: BoundPromotionExpectedLeaf | undefined,
): Promise<{ manifest: ComparisonManifest; leaf: BoundPromotionExpectedLeaf }> {
  const result = await boundPromotionReadFile({
    root: root.path,
    rootIdentity: promotionIdentityOf(root),
    components: ["manifest.json"],
    parentIdentity: promotionIdentityOf(root),
    ...(expected ? { expectedIdentity: expected.identity } : {}),
    maxBytes: MAX_WORLDLINE_FILE_BYTES,
  });
  const parsed = parseComparisonManifest(JSON.parse(result.content.toString("utf8")) as unknown);
  if (!parsed) throw new Error("comparison manifest is invalid");
  return {
    manifest: parsed,
    leaf: {
      identity: result.identity,
      state: { type: "file", mode: 0o600, size: String(result.content.byteLength), sha256: sha256Hex(result.content) },
    },
  };
}

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

function assertBoundPromotionDirectory(bound: BoundPromotionDirectory): void {
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

async function existingPromotionDirectoryIdentity(path: string, field: string): Promise<PromotionFsIdentity | undefined> {
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
async function ensureBoundRelativeDirectory(root: BoundPromotionDirectory, components: string[], field: string): Promise<BoundPromotionDirectory> {
  let current = root;
  for (const name of components) {
    if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new Error(`invalid ${field} component`);
    current = await ensureBoundChildDirectory(current, name);
  }
  return current;
}

let promotionRecoveryTestHook: PromotionRecoveryTestHook | null = null;

/** Test-only deterministic interleaving seam; never exposed through IPC. */
export function setPromotionRecoveryTestHookForTest(hook: PromotionRecoveryTestHook | null): void {
  promotionRecoveryTestHook = hook;
}

async function runPromotionRecoveryTestHook(stage: "after-journal-validation", journalDir: string): Promise<void> {
  await promotionRecoveryTestHook?.(stage, journalDir);
}

type PromotionRollbackTemp =
  | { status: "planned"; rel: string; path: string; parent: string; parentDev: number; parentIno: number }
  | { status: "created"; rel: string; path: string; parent: string; parentDev: number; parentIno: number; dev: number; ino: number; state: PromotionEntryState };
type PromotionParentIdentity = { path: string; dev: number; ino: number; capability?: string };
const EMPTY_PROMOTION_HASH = sha256Hex(Buffer.alloc(0));
const SHA256_HEX = /^[0-9a-f]{64}$/;


function statIdentityEqual(a: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }, b: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

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

function promotionNoFollowFlag(): number {
  const flag = (fsConstants as Record<string, unknown>).O_NOFOLLOW;
  if (typeof flag !== "number" || flag === 0) throw new Error("promotion recovery requires O_NOFOLLOW support");
  return flag;
}

function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

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

function validatePromotionJournalPaths(journal: Record<string, unknown>): PromotionJournalPath[] {
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

function validatePromotionRollbackTemps(journal: Record<string, unknown>): PromotionRollbackTemp[] {
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

function validatePromotionJournalHeader(journal: Record<string, unknown>, primaryRoot: string): void {
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

async function assertPromotionState(abs: string, expected: PromotionEntryState, message: string): Promise<void> {
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

function isSafePromotionRelativePath(rel: string): boolean {
  return rel.length > 0 && rel !== "." && rel.indexOf("\0") === -1 && !isAbsolute(rel) && !rel.startsWith("/") && !rel.split(/[\\/]/).includes("..");
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

async function filesystemCanonicalPath(absPath: string): Promise<string> {
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

function promotionParentComponents(root: string, parent: string): string[] {
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

async function verifyInstalledBundleAgainstManifest(bundleDir: string, manifest: PromotionArtifactManifest): Promise<boolean> {
  if (manifest.status !== "created") return true;
  if (resolve(manifest.path) !== resolve(bundleDir)) return false;
  let recomputed: PromotionArtifactManifest;
  try {
    recomputed = await createPromotionArtifactManifest(bundleDir);
  } catch {
    return false;
  }
  if (recomputed.status !== "created") return false;
  if (recomputed.entries.length !== manifest.entries.length) return false;
  const currentByRel = new Map(recomputed.entries.map((entry) => [entry.rel, entry]));
  for (const expected of manifest.entries) {
    const actual = currentByRel.get(expected.rel);
    if (!actual) return false;
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) return false;
    if (!promotionStatesEqual(actual.state, expected.state)) return false;
  }
  return true;
}

/**
 * Crash-complete an `applied` journal without a session worker.
 *
 * The merged tree is already durable when phase is `applied`. When every
 * journaled path still equals its after-state and the installed bundle is
 * already present (or the staged bundle can be moved into place), leave the
 * merged tree and report completion. Any other shape is impossible without a
 * fork, so the caller falls back to rollback.
 */
async function tryCompleteAppliedPromotion(
  journalDir: string,
  journal: Record<string, unknown>,
  primaryRoot: string,
  canonicalPath: CanonicalPath,
  journalBinding: PromotionJournalBinding,
): Promise<boolean> {
  try {
    if (String(journal.phase) !== "applied") return false;
    validatePromotionJournalHeader(journal, primaryRoot);
    const paths = validatePromotionJournalPaths(journal);
    const uncertain = journal.uncertainSessionArtifacts;
    if (Array.isArray(uncertain) && uncertain.length > 0) return false;
    const stagedSession = journal.stagedSession;
    const installedSession = journal.installedSession;
    if (typeof stagedSession !== "string" || typeof installedSession !== "string") return false;
    const sessionRootPath = join(journalDir, "session");
    if (!isInside(resolve(sessionRootPath), resolve(stagedSession))) return false;
    const parsed = parseSessionBundlePath(installedSession);
    if (!parsed) return false;
    const manifest = parsePromotionArtifactManifest(journal.installedSessionManifest, "installedSession");
    if (!manifest) return false;
    if (resolve(manifest.path) !== resolve(parsed.bundleDir)) return false;
    const canonicalRoot = await canonicalPath(primaryRoot);
    for (const entry of paths) {
      const abs = await promotionDestination(primaryRoot, canonicalRoot, entry.rel, canonicalPath);
      const current = (await readPromotionEntry(abs)).state;
      if (!promotionStatesEqual(current, entry.afterState!)) return false;
    }
    try {
      const installedInfo = await lstatPath(parsed.bundleDir);
      if (installedInfo.isDirectory() && !installedInfo.isSymbolicLink()) {
        const installedState = (await readPromotionEntry(installedSession)).state;
        if (installedState.type === "file") {
          if (manifest.status === "created" && !(await verifyInstalledBundleAgainstManifest(parsed.bundleDir, manifest))) return false;
          return true;
        }
        return false;
      }
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") return false;
    }
    if (manifest.status !== "planned") return false;
    const stagedBundleDir = join(sessionRootPath, parsed.sessionId);
    const sessionRootPlan = await probePromotionDirectory(journalBinding.directory, sessionRootPath, "promotion recovery session root");
    if (!sessionRootPlan.identity) return false;
    const stagedPlan = await probePromotionDirectory(journalBinding.directory, stagedBundleDir, "promotion recovery staged bundle");
    if (!stagedPlan.identity) return false;
    let stagedInfo;
    try {
      stagedInfo = await lstatPath(stagedBundleDir, { bigint: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      return false;
    }
    if (!stagedInfo.isDirectory() || stagedInfo.isSymbolicLink()) return false;
    if (String(stagedInfo.dev) !== stagedPlan.identity.dev || String(stagedInfo.ino) !== stagedPlan.identity.ino) return false;
    const stagedState = (await readPromotionEntry(join(stagedBundleDir, "current", "session.jsonl"))).state;
    if (stagedState.type !== "file") return false;
    let destInfo;
    try {
      destInfo = await lstatPath(parsed.projectDir, { bigint: true });
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return false;
      return false;
    }
    if (!destInfo.isDirectory() || destInfo.isSymbolicLink()) return false;
    let destIdentity: PromotionFsIdentity;
    try {
      destIdentity = await boundPromotionOpenDirectory({
        path: parsed.projectDir,
        expectedIdentity: { dev: String(destInfo.dev), ino: String(destInfo.ino) },
      });
    } catch {
      return false;
    }
    const sourceRootBinding: BoundPromotionDirectory = {
      path: sessionRootPath,
      dev: sessionRootPlan.identity.dev,
      ino: sessionRootPlan.identity.ino,
      capability: sessionRootPlan.identity.capability,
    };
    const destRootBinding: BoundPromotionDirectory = {
      path: parsed.projectDir,
      dev: destIdentity.dev,
      ino: destIdentity.ino,
      capability: destIdentity.capability,
    };
    try {
      const moved = await boundPromotionInstallDirectory({
        sourceRoot: sourceRootBinding.path,
        sourceRootIdentity: promotionIdentityOf(sourceRootBinding),
        sourceComponents: [parsed.sessionId],
        sourceParentIdentity: promotionIdentityOf(sourceRootBinding),
        expectedSource: {
          identity: { dev: stagedPlan.identity.dev, ino: stagedPlan.identity.ino },
          mode: Number(stagedInfo.mode & 0o777n),
        },
        destinationRoot: destRootBinding.path,
        destinationRootIdentity: promotionIdentityOf(destRootBinding),
        destinationComponents: [parsed.sessionId],
        destinationParentIdentity: promotionIdentityOf(destRootBinding),
      });
      if (moved.outcome !== "applied" || !moved.durable) return false;
    } catch {
      return false;
    }
    try {
      const installedInfo = await lstatPath(parsed.bundleDir);
      if (!installedInfo.isDirectory() || installedInfo.isSymbolicLink()) return false;
      if ((await readPromotionEntry(installedSession)).state.type !== "file") return false;
    } catch {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function rollbackPromotionPaths(
  journalDir: string,
  journal: Record<string, unknown>,
  primaryRoot: string,
  canonicalPath: CanonicalPath,
  journalBinding?: PromotionJournalBinding,
  primaryRootBinding?: BoundPromotionDirectory,
  readonlyJournal = false,
): Promise<boolean> {
  const persistJournal = async (): Promise<void> => {
    if (readonlyJournal) return;
    if (!journalBinding) throw new Error("promotion journal binding is missing");
    await writePromotionJournal(journalBinding, journal);
  };
  const persistConflict = async (value: unknown): Promise<void> => {
    if (readonlyJournal) return;
    if (!journalBinding) throw new Error("promotion journal binding is missing");
    await boundPromotionWriteFile({
      root: journalBinding.directory.path,
      rootIdentity: promotionIdentityOf(journalBinding.directory),
      components: ["conflict.json"],
      parentIdentity: promotionIdentityOf(journalBinding.directory),
      expectedDestination: { state: { type: "missing" } },
      content: Buffer.from(JSON.stringify(value, null, 2)),
      mode: 0o600,
    });
  };
  if (journalBinding) assertBoundPromotionDirectory(journalBinding.directory);
  validatePromotionJournalHeader(journal, primaryRoot);
  const paths = validatePromotionJournalPaths(journal);
  validatePromotionRollbackTemps(journal);
  // Bind the recovery root and every currently-existing destination parent
  // before reading mutable primary entries.  Recovery must not turn a journal
  // path into a fresh trust decision after an ancestor swap.
  const primaryRootBindingResolved = primaryRootBinding ?? await ensureBoundDirectory(primaryRoot, "promotion recovery primary root");
  const parentPlans = new Map<string, PromotionDirectoryPlan>();
  for (const path of paths) {
    const parentPath = resolve(dirname(join(primaryRoot, path.rel)));
    if (!parentPlans.has(parentPath)) {
      parentPlans.set(parentPath, await probePromotionDirectory(primaryRootBindingResolved, parentPath, "promotion recovery parent"));
    }
  }
  const canonicalRoot = await canonicalPath(primaryRoot);
  // Rollback temps are retained evidence. Removing one by pathname after an
  // identity check is a check-to-use race and can delete a replacement; the
  // native exchange/retire boundary below preserves both operands instead.
  const conflictPaths: string[] = [];
  for (const p of paths) {
    let restoreTmp: string | null = null;
    let restoreRecord: PromotionRollbackTemp | null = null;
    let restoreExpected: BoundPromotionExpectedLeaf | null = null;
    try {
      const beforeState = p.beforeState!;
      const afterState = p.afterState!;
      let abs = await promotionDestination(primaryRoot, canonicalRoot, p.rel, canonicalPath);
      const current = (await readPromotionEntry(abs)).state;
      if (promotionStatesEqual(current, beforeState)) continue;
      if (!promotionStatesEqual(current, afterState)) throw new Error(`filesystem state conflicts at ${p.rel}`);

      let beforeExpected: BoundPromotionExpectedLeaf | null = null;
      if (beforeState.type === "file") {
        const savedPath = join(journalDir, "before", p.rel);
        if (!journalBinding) throw new Error(`before-image journal binding is missing at ${p.rel}`);
        assertBoundPromotionDirectory(journalBinding.directory);
        if (p.beforeImageIdentity && p.beforeImageSize) {
          beforeExpected = {
            identity: p.beforeImageIdentity,
            state: {
              type: "file",
              mode: beforeState.mode ?? 0o644,
              size: p.beforeImageSize,
              sha256: beforeState.hash,
            },
          };
        } else {
          // Journals written before the native evidence boundary have no
          // persisted image identity. Read only to derive a one-time expected
          // descriptor; the native copy below still rejects a replacement.
          const saved = await readPromotionEntry(savedPath);
          if (saved.state.type !== "file" || saved.state.hash !== beforeState.hash || !saved.bytes) throw new Error(`before-image is corrupt at ${p.rel}`);
          beforeExpected = await boundPromotionExpectedLeaf(savedPath, beforeState, `before-image ${p.rel}`);
        }
      }
      if (beforeState.type === "file" || beforeState.type === "symlink") {
        const parentPlan = parentPlans.get(resolve(dirname(abs)));
        if (!parentPlan) throw new Error(`promotion recovery parent was not pre-bound: ${dirname(abs)}`);
        const parent = await promotionParentIdentity(abs, canonicalRoot, canonicalPath, parentPlan);
        restoreTmp = join(parent.path, `.termina-promotion-${randomUUID()}.tmp`);
        restoreRecord = { status: "planned", rel: p.rel, path: restoreTmp, parent: parent.path, parentDev: parent.dev, parentIno: parent.ino };
        journal.rollbackTemps = [restoreRecord];
        await persistJournal();
        const primaryRootInfo = primaryRootBindingResolved;
        const primaryParent: BoundPromotionDirectory = { path: parent.path, dev: String(parent.dev), ino: String(parent.ino) };
        const tempComponents = [...promotionParentComponents(primaryRoot, parent.path), basename(restoreTmp)];
        if (beforeState.type === "file") {
          if (!beforeExpected || !journalBinding) throw new Error(`before-image expectation is missing at ${p.rel}`);
          const beforeParent = await ensureBoundRelativeDirectory(journalBinding.directory, ["before", ...promotionSourceComponents(p.rel).slice(0, -1)], "before-image rollback parent");
          restoreExpected = await boundPromotionCopyFile({
            sourceRoot: journalBinding.directory.path,
            sourceRootIdentity: promotionIdentityOf(journalBinding.directory),
            sourceComponents: ["before", ...promotionSourceComponents(p.rel)],
            sourceParentIdentity: promotionIdentityOf(beforeParent),
            expectedSource: beforeExpected,
            destinationRoot: primaryRootInfo.path,
            destinationRootIdentity: promotionIdentityOf(primaryRootInfo),
            destinationComponents: tempComponents,
            destinationParentIdentity: promotionIdentityOf(primaryParent),
          });
        } else {
          const created = await boundPromotionCreateSymlink({
            root: primaryRootInfo.path,
            rootIdentity: promotionIdentityOf(primaryRootInfo),
            components: tempComponents,
            parentIdentity: promotionIdentityOf(primaryParent),
            target: beforeState.target,
          });
          restoreExpected = created;
        }
        if (!restoreExpected) throw new Error(`rollback temp was not created at ${p.rel}`);
        const restoreState: PromotionEntryState = restoreExpected.state.type === "file"
          ? { type: "file", mode: restoreExpected.state.mode, hash: restoreExpected.state.sha256 }
          : { type: "symlink", target: restoreExpected.state.target };
        restoreRecord = { ...restoreRecord, status: "created", dev: Number(restoreExpected.identity.dev), ino: Number(restoreExpected.identity.ino), state: restoreState };
        journal.rollbackTemps = [restoreRecord];
        await persistJournal();
      }

      abs = await promotionDestination(primaryRoot, canonicalRoot, p.rel, canonicalPath);
      const finalParentPlan = parentPlans.get(resolve(dirname(abs)));
      if (!finalParentPlan) throw new Error(`promotion recovery parent was not pre-bound: ${dirname(abs)}`);
      const finalParent = await promotionParentIdentity(abs, canonicalRoot, canonicalPath, finalParentPlan);
      if (restoreRecord && (finalParent.path !== restoreRecord.parent || finalParent.dev !== restoreRecord.parentDev || finalParent.ino !== restoreRecord.parentIno)) {
        throw new Error(`promotion parent changed before rollback at ${p.rel}`);
      }
      if (beforeState.type === "missing") {
        await assertPromotionState(abs, afterState, `filesystem state changed before rollback at ${p.rel}`);
        const rootIdentity = promotionIdentityOf(primaryRootBindingResolved);
        const parentIdentity = { dev: String(finalParent.dev), ino: String(finalParent.ino) };
        const retainedName = basename(p.retainedName ?? `.termina-promotion-retained-${sha256Hex(Buffer.from(`${journal.opId ?? "promotion"}:${p.rel}`)).slice(0, 24)}.tmp`);
        if (!p.retainedName) {
          p.retainedName = retainedName;
          journal.paths = paths;
          await persistJournal();
        }
        const result = await boundPromotionTransition({
          primaryRoot,
          primaryRootIdentity: rootIdentity,
          destinationComponents: promotionDestinationComponents(primaryRoot, finalParent.path, p.rel),
          parentIdentity,
          transition: {
            kind: "retire",
            retainedName,
            expectedDestination: await boundPromotionExpectedLeaf(abs, afterState, `promotion destination ${p.rel}`),
          },
        });
        if (result.outcome !== "applied" || !result.durable) throw new Error(result.error ?? `promotion retire conflict at ${p.rel}`);
        p.retainedName = retainedName;
      } else if (restoreTmp) {
        if (!restoreRecord || restoreRecord.status !== "created") throw new Error(`rollback temp was not committed at ${p.rel}`);
        await assertPromotionState(abs, afterState, `filesystem state changed before rollback at ${p.rel}`);
        const rootIdentity = promotionIdentityOf(primaryRootBindingResolved);
        const parentIdentity = { dev: String(finalParent.dev), ino: String(finalParent.ino) };
        if (!restoreExpected) throw new Error(`rollback temp expectation is missing at ${p.rel}`);
        const expectedSource = restoreExpected;
        const result = afterState.type === "missing"
          ? await boundPromotionTransition({
              primaryRoot,
              primaryRootIdentity: rootIdentity,
              destinationComponents: promotionDestinationComponents(primaryRoot, finalParent.path, p.rel),
              parentIdentity,
              transition: {
                kind: "install",
                sourceRoot: primaryRoot,
                sourceRootIdentity: rootIdentity,
                sourceComponents: promotionSourceComponents(relative(primaryRoot, restoreTmp)),
                sourceParentIdentity: parentIdentity,
                expectedSource,
                expectedDestination: { state: { type: "missing" } },
              },
            })
          : await boundPromotionTransition({
              primaryRoot,
              primaryRootIdentity: rootIdentity,
              destinationComponents: promotionDestinationComponents(primaryRoot, finalParent.path, p.rel),
              parentIdentity,
              transition: {
                kind: "exchange",
                sourceName: basename(restoreTmp),
                expectedSource,
                expectedDestination: await boundPromotionExpectedLeaf(abs, afterState, `promotion destination ${p.rel}`),
              },
            });
        if (result.outcome !== "applied" || !result.durable) throw new Error(result.error ?? `promotion exchange conflict at ${p.rel}`);
      } else {
        throw new Error(`unsupported before-state at ${p.rel}`);
      }
      await assertPromotionState(abs, beforeState, `rollback verification failed at ${p.rel}`);
    } catch {
      conflictPaths.push(typeof p.rel === "string" ? p.rel : "<invalid path>");
    }
  }
  const conflicted = conflictPaths.length > 0;
  if (conflicted) {
    journal.phase = "conflict";
    await persistJournal();
    await persistConflict({ at: Date.now(), paths: conflictPaths });
    return false;
  }
  return true;
}

export async function rollbackPromotion(
  journalDir: string,
  journal: Record<string, unknown>,
  primaryRoot: string,
  canonicalPath: CanonicalPath,
  journalBinding?: PromotionJournalBinding,
  primaryRootBinding?: BoundPromotionDirectory,
): Promise<boolean> {
  const phase = String(journal.phase ?? "prepared");
  if (!["prepared", "applying", "applied"].includes(phase)) {
    // A failed live promotion retains unexpected-phase evidence as well. The
    // directory pathname is not deletion provenance once control left the
    // creation step; only the successful completion path removes its own
    // freshly created journal.
    return false;
  }
  // Live failure after `applied` still rolls back: the synchronous session
  // install already failed, so files and session stay atomic by restoring the
  // before-images. Crash recovery (`recoverPromotionJournals`) instead tries
  // `tryCompleteAppliedPromotion` first and only rolls back when completion
  // is impossible.
  return rollbackPromotionPaths(journalDir, journal, primaryRoot, canonicalPath, journalBinding, primaryRootBinding);
}

/** Startup recovery: finish or roll back every pending promotion journal. */
export async function recoverPromotionJournals(worldsRoot: string, context: PromotionRecoveryContext): Promise<void> {
  const binding = await ensureBoundDirectory(worldsRoot, "worlds root");
  const owner = promotionJournalAdmissionOwnerFor(binding);
  const releaseOwner = owner.register();
  try {
    return await withPromotionTransaction(() => owner.withLock(() => recoverPromotionJournalsUnderTransaction(worldsRoot, context)));
  } finally {
    releaseOwner();
    releasePromotionJournalAdmissionOwner(owner);
  }
}

/**
 * Establish the current-format promotion roots for a freshly-created fixture.
 *
 * This deliberately delegates to the same strict binder used by startup and
 * recovery: missing leaves are created below a trusted parent and receive a
 * persisted identity; an existing unproven leaf is rejected. Production
 * startup never calls this setup helper.
 */
export async function ensurePromotionRoots(worldsRoot: string, primaryRoot: string): Promise<void> {
  return withPromotionTransaction(async () => {
    const worldsRootBinding = await ensureBoundDirectory(worldsRoot, "worlds root");
    await ensureBoundDirectory(primaryRoot, "primary root", worldsRootBinding);
  });
}

/** Stop the shared native helper when a focused Worldline harness exits. */
export function disposeWorldlineCoreClient(): void {
  disposeWorldlineGitCore();
}

async function recoverPromotionJournalsUnderTransaction(worldsRoot: string, context: PromotionRecoveryContext): Promise<void> {
  let root: BoundPromotionDirectory;
  let primaryRootBinding: BoundPromotionDirectory;
  let entries: Array<{ name: string; identity: PromotionFsIdentity }>;
  try {
    // Bind the app-owned worlds root from its trusted parent first. The
    // recovery journal itself is then opened as a child of that capability;
    // no first identity is accepted from a mutable journal pathname.
    const worldsRootBinding = await ensureBoundDirectory(worldsRoot, "worlds root");
    const primaryIdentity = await existingPromotionDirectoryIdentity(
      context.primaryRoot,
      "promotion recovery primary root",
    );
    if (!primaryIdentity) throw new Error("promotion recovery primary root is missing");
    primaryRootBinding = await ensureBoundDirectory(
      context.primaryRoot,
      "promotion recovery primary root",
      worldsRootBinding,
      { initialIdentity: primaryIdentity },
    );
    const rootPath = join(worldsRootBinding.path, "promotion-journal");
    const identity = await boundPromotionPrepareDirectory({
      root: worldsRootBinding.path,
      rootIdentity: promotionIdentityOf(worldsRootBinding),
      components: ["promotion-journal"],
      createMissing: true,
    });
    if (!identity.identity) return;
    root = {
      path: rootPath,
      dev: identity.identity.dev,
      ino: identity.identity.ino,
      capability: identity.identity.capability,
    };
    entries = await boundPromotionListDirectories({
      root: root.path,
      rootIdentity: promotionIdentityOf(root),
    });
  } catch (error) {
    console.warn(`[worldline] promotion root bind failed closed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const entry of entries) {
    let dir: BoundPromotionDirectory;
    try {
      assertBoundPromotionDirectory(root);
      dir = { path: join(root.path, entry.name), dev: entry.identity.dev, ino: entry.identity.ino };
    } catch {
      continue;
    }
    let journal: Record<string, unknown> | null = null;
    try {
      assertBoundPromotionDirectory(dir);
      await runPromotionRecoveryTestHook("after-journal-validation", dir.path);
      const journalBytes = await readBoundPromotionJournal({
        journalRoot: root.path,
        journalRootIdentity: promotionIdentityOf(root),
        operationName: basename(dir.path),
        operationIdentity: { dev: dir.dev, ino: dir.ino },
      });
      journal = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(journalBytes)) as Record<string, unknown>;
    } catch {
      // Recovery never writes a marker into a journal-selected path. A bound
      // directory can still be swapped after a path identity check, and Node
      // offers no descriptor-relative atomic marker creation here.
      console.warn(`[worldline] unreadable promotion journal retained: ${dir.path}`);
      continue;
    }
    try {
      const phase = String(journal.phase ?? "prepared");
      const primaryRoot = String(journal.primaryRoot ?? "");
      if (primaryRoot !== context.primaryRoot) continue;
      if (!["prepared", "applying", "applied"].includes(phase)) {
        if (phase === "conflict") continue;
        if (phase === "done" || phase === "rolled-back") continue;
        console.warn(`[worldline] promotion journal with unknown phase retained: ${dir.path}`);
        continue;
      }
      const recoveryBinding: PromotionJournalBinding = {
        root,
        directory: dir,
        name: entry.name,
        journalFile: null,
      };
      if (phase === "applied") {
        const completed = await tryCompleteAppliedPromotion(dir.path, journal, primaryRoot, filesystemCanonicalPath, recoveryBinding);
        if (completed) {
          console.warn(`[worldline] promotion journal completed with artifacts retained: ${dir.path}`);
          continue;
        }
      }
      const rolledBack = await rollbackPromotionPaths(
        dir.path,
        journal,
        primaryRoot,
        filesystemCanonicalPath,
        recoveryBinding,
        primaryRootBinding,
        true,
      );
      if (rolledBack) {
        // Do not delete installed sessions, rollback temps, or the journal in
        // recovery. Journal-provided paths/manifests are not sufficient
        // provenance to destroy a live agent session, and Node cannot make
        // the final remove sink descriptor-relative.
        console.warn(`[worldline] promotion journal recovered with artifacts retained: ${dir.path}`);
      } else {
        console.warn(`[worldline] promotion recovery conflict: ${dir.path} — kept every version`);
      }
    } catch {
      console.warn(`[worldline] promotion recovery failed closed: ${dir.path}`);
    }
  }
}
