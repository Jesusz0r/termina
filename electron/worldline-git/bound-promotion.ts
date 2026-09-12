/**
 * Descriptor-bound promotion operations.
 *
 * Owns bound directory/file/journal operations. Split from
 * electron/worldline-git.ts (issue #38).
 */
import { coreClient } from "./core-process.js";
import { lstatSync } from "node:fs";


/** Decimal device/inode identity used by the native promotion boundary. */
export interface PromotionFsIdentity {
  dev: string;
  ino: string;
  /** Opaque capability retained by the long-lived native core process. */
  capability?: string;
}


export interface BoundPromotionJournalRead {
  journalRoot: string;
  journalRootIdentity: PromotionFsIdentity;
  operationName: string;
  operationIdentity: PromotionFsIdentity;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}


export type BoundPromotionExpectedState =
  | { type: "file"; mode: number; size: string; sha256: string }
  | { type: "symlink"; target: string };


export interface BoundPromotionExpectedLeaf {
  identity: PromotionFsIdentity;
  state: BoundPromotionExpectedState;
}


export interface BoundPromotionExpectedMissing {
  state: { type: "missing" };
}


export interface BoundPromotionDirectoryResult {
  path: string;
  identity: PromotionFsIdentity;
}


export interface BoundPromotionLeafResult {
  leaf: BoundPromotionExpectedLeaf;
}


export type BoundPromotionTransitionRequest = {
  primaryRoot: string;
  primaryRootIdentity: PromotionFsIdentity;
  destinationComponents: string[];
  parentIdentity: PromotionFsIdentity;
  testHook?: { stage: string; readyPath: string; releasePath: string };
  transition:
    | {
        kind: "exchange";
        sourceName: string;
        expectedSource: BoundPromotionExpectedLeaf;
        expectedDestination: BoundPromotionExpectedLeaf;
      }
      | {
        kind: "retire";
        retainedName: string;
        expectedDestination: BoundPromotionExpectedLeaf;
        retainedRoot?: string;
        retainedRootIdentity?: PromotionFsIdentity;
        retainedComponents?: string[];
        retainedParentIdentity?: PromotionFsIdentity;
      }
    | {
        kind: "install";
        sourceRoot: string;
        sourceRootIdentity: PromotionFsIdentity;
        sourceComponents: string[];
        sourceParentIdentity: PromotionFsIdentity;
        expectedSource: BoundPromotionExpectedLeaf;
        expectedDestination: BoundPromotionExpectedLeaf | BoundPromotionExpectedMissing;
      };
};


export interface BoundPromotionTransitionResult {
  outcome: "applied" | "conflict-after-mutation";
  transition: "exchange" | "retire" | "install";
  durable: boolean;
  retainedName: string | null;
  error: string | null;
}


function decodeBoundPromotionBytes(response: unknown): Buffer {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("invalid bound promotion journal response");
  const value = response as Record<string, unknown>;
  if (typeof value.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.content)) {
    throw new Error("invalid bound promotion journal bytes");
  }
  if (!Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 0) throw new Error("invalid bound promotion journal byte length");
  const bytes = Buffer.from(value.content, "base64");
  if (bytes.byteLength !== Number(value.byteLength)) throw new Error("bound promotion journal byte length mismatch");
  return bytes;
}


/** Read journal bytes below an operation directory held by the Rust core. */
export async function readBoundPromotionJournal(options: BoundPromotionJournalRead): Promise<Buffer> {
  const response = await coreClient.request({
    op: "promotion-bound-read-journal",
    journalRoot: options.journalRoot,
    journalRootIdentity: { dev: options.journalRootIdentity.dev, ino: options.journalRootIdentity.ino },
    ...(options.journalRootIdentity.capability ? { journalRootCapability: options.journalRootIdentity.capability } : {}),
    operationName: options.operationName,
    operationIdentity: options.operationIdentity,
    ...(options.testHook ? { testHook: options.testHook } : {}),
  });
  return decodeBoundPromotionBytes(response);
}


/** Read one bounded private file below an identity-bound parent. */
export async function boundPromotionReadFile(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
  components: string[];
  parentIdentity: PromotionFsIdentity;
  expectedIdentity?: PromotionFsIdentity;
  maxBytes?: number;
}): Promise<{ content: Buffer; identity: PromotionFsIdentity }> {
  const response = await coreClient.request({
    op: "promotion-bound-read-file",
    root: options.root,
    rootIdentity: { dev: options.rootIdentity.dev, ino: options.rootIdentity.ino },
    ...(options.rootIdentity.capability ? { rootCapability: options.rootIdentity.capability } : {}),
    components: options.components,
    parentIdentity: options.parentIdentity,
    ...(options.expectedIdentity ? { expectedIdentity: { dev: options.expectedIdentity.dev, ino: options.expectedIdentity.ino } } : {}),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  const value = response as Record<string, unknown>;
  const content = decodeBoundPromotionBytes(response);
  const identity = decodePromotionIdentity(value.identity, "bound promotion read file identity");
  return { content, identity };
}


/** Execute one preservation-first, descriptor-relative promotion transition. */
export async function boundPromotionTransition(options: BoundPromotionTransitionRequest): Promise<BoundPromotionTransitionResult> {
  const transition = options.transition;
  const payload: Record<string, unknown> = {
    ...options,
    primaryRootIdentity: promotionIdentityPayload(options.primaryRootIdentity),
    ...(options.primaryRootIdentity.capability ? { primaryRootCapability: options.primaryRootIdentity.capability } : {}),
  };
  if (transition.kind === "install") {
    payload.transition = {
      ...transition,
      sourceRootIdentity: promotionIdentityPayload(transition.sourceRootIdentity),
      ...(transition.sourceRootIdentity.capability ? { sourceRootCapability: transition.sourceRootIdentity.capability } : {}),
    };
  } else if (transition.kind === "retire" && transition.retainedRootIdentity) {
    payload.transition = {
      ...transition,
      retainedRootIdentity: promotionIdentityPayload(transition.retainedRootIdentity),
      ...(transition.retainedRootIdentity.capability ? { retainedRootCapability: transition.retainedRootIdentity.capability } : {}),
    };
  }
  const response = (await coreClient.request({
    op: "promotion-bound-transition",
    ...payload,
  })) as { result?: unknown };
  const result = response?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid bound promotion transition response");
  const value = result as Record<string, unknown>;
  if (
    (value.outcome !== "applied" && value.outcome !== "conflict-after-mutation")
    || (value.transition !== "exchange" && value.transition !== "retire" && value.transition !== "install")
    || typeof value.durable !== "boolean"
    || (value.retainedName !== null && typeof value.retainedName !== "string")
    || (value.error !== null && typeof value.error !== "string")
  ) {
    throw new Error("invalid bound promotion transition result");
  }
  return {
    outcome: value.outcome,
    transition: value.transition,
    durable: value.durable,
    retainedName: value.retainedName,
    error: value.error,
  };
}


function decodePromotionIdentity(value: unknown, field: string): PromotionFsIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${field}`);
  const object = value as Record<string, unknown>;
  if (typeof object.dev !== "string" || !/^\d+$/.test(object.dev) || typeof object.ino !== "string" || !/^\d+$/.test(object.ino)) {
    throw new Error(`invalid ${field}`);
  }
  return { dev: object.dev, ino: object.ino };
}


export function promotionIdentityPayload(identity: PromotionFsIdentity): { dev: string; ino: string } {
  return { dev: identity.dev, ino: identity.ino };
}


function decodePromotionLeaf(value: unknown, field: string): BoundPromotionExpectedLeaf {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${field}`);
  const object = value as Record<string, unknown>;
  const identity = decodePromotionIdentity(object.identity, `${field}.identity`);
  if (!object.state || typeof object.state !== "object" || Array.isArray(object.state)) throw new Error(`invalid ${field}.state`);
  const state = object.state as Record<string, unknown>;
  if (state.type === "file" && typeof state.mode === "number" && Number.isInteger(state.mode) && state.mode >= 0 && state.mode <= 0o777 && typeof state.size === "string" && /^\d+$/.test(state.size) && typeof state.sha256 === "string" && /^[0-9a-f]{64}$/.test(state.sha256)) {
    return { identity, state: { type: "file", mode: state.mode, size: state.size, sha256: state.sha256 } };
  }
  if (state.type === "symlink" && typeof state.target === "string" && !state.target.includes("\0")) {
    return { identity, state: { type: "symlink", target: state.target } };
  }
  throw new Error(`invalid ${field}.state`);
}


function decodePromotionResponse(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("invalid bound promotion response");
  const result = (response as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid bound promotion result");
  return result as Record<string, unknown>;
}


/** Open one trusted absolute directory in the native boundary. */
export async function boundPromotionOpenDirectory(options: {
  path: string;
  expectedIdentity?: PromotionFsIdentity;
  capability?: string;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<PromotionFsIdentity> {
  let expectedIdentity = options.expectedIdentity;
  if (!expectedIdentity && !options.capability) {
    const metadata = lstatSync(options.path, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("bound promotion directory is not a real directory");
    expectedIdentity = { dev: String(metadata.dev), ino: String(metadata.ino) };
  }
  const response = await coreClient.request({
    op: "promotion-bound-open-directory",
    path: options.path,
    ...(expectedIdentity ? { expectedIdentity: { dev: expectedIdentity.dev, ino: expectedIdentity.ino } } : {}),
    ...(options.capability ? { capability: options.capability } : {}),
    ...(options.testHook ? { testHook: options.testHook } : {}),
  });
  const result = decodePromotionResponse(response);
  const identity = decodePromotionIdentity(result.identity, "bound promotion opened directory identity");
  if (typeof result.capability !== "string" || result.capability.length === 0) throw new Error("bound promotion opened directory capability is missing");
  return { ...identity, capability: result.capability };
}


/** List immediate child directories with identities captured by Core. */
export async function boundPromotionListDirectories(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
}): Promise<Array<{ name: string; identity: PromotionFsIdentity }>> {
  const response = await coreClient.request({
    op: "promotion-bound-list-directories",
    root: options.root,
    rootIdentity: { dev: options.rootIdentity.dev, ino: options.rootIdentity.ino },
    ...(options.rootIdentity.capability ? { rootCapability: options.rootIdentity.capability } : {}),
  });
  const result = decodePromotionResponse(response);
  if (!Array.isArray(result.entries)) throw new Error("invalid bound promotion directory entries");
  return result.entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid bound promotion directory entry ${index}`);
    const value = entry as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.length === 0 || value.name.includes("/") || value.name.includes("\\") || value.name === "." || value.name === "..") {
      throw new Error(`invalid bound promotion directory name ${index}`);
    }
    return { name: value.name, identity: decodePromotionIdentity(value.identity, `bound promotion directory identity ${index}`) };
  });
}


/** List immediate entries with native namespace identities for cleanup. */
export async function boundPromotionListEntries(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
}): Promise<Array<{ name: string; identity: PromotionFsIdentity; kind: "directory" | "file" | "symlink" | "other" }>> {
  const response = await coreClient.request({
    op: "promotion-bound-list-entries",
    root: options.root,
    rootIdentity: { dev: options.rootIdentity.dev, ino: options.rootIdentity.ino },
    ...(options.rootIdentity.capability ? { rootCapability: options.rootIdentity.capability } : {}),
  });
  const result = decodePromotionResponse(response);
  if (!Array.isArray(result.entries)) throw new Error("invalid bound promotion entries");
  return result.entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid bound promotion entry ${index}`);
    const value = entry as Record<string, unknown>;
    if (typeof value.name !== "string" || value.name.length === 0 || value.name.includes("/") || value.name.includes("\\") || value.name === "." || value.name === "..") {
      throw new Error(`invalid bound promotion entry name ${index}`);
    }
    if (value.kind !== "directory" && value.kind !== "file" && value.kind !== "symlink" && value.kind !== "other") {
      throw new Error(`invalid bound promotion entry kind ${index}`);
    }
    return {
      name: value.name,
      identity: decodePromotionIdentity(value.identity, `bound promotion entry identity ${index}`),
      kind: value.kind,
    };
  });
}


/** Probe/create a directory chain below a natively bound root. */
export async function boundPromotionPrepareDirectory(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
  components?: string[];
  createMissing?: boolean;
  allowMissing?: boolean;
  expectedMissingAt?: number;
  expectedChain?: PromotionFsIdentity[];
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<{ identity: PromotionFsIdentity | null; missingAt: number | null; chain: PromotionFsIdentity[] }> {
  const response = await coreClient.request({
    op: "promotion-bound-prepare-directory",
    root: options.root,
    rootIdentity: { dev: options.rootIdentity.dev, ino: options.rootIdentity.ino },
    ...(options.rootIdentity.capability ? { rootCapability: options.rootIdentity.capability } : {}),
    components: options.components ?? [],
    ...(options.createMissing === undefined ? {} : { createMissing: options.createMissing }),
    ...(options.allowMissing === undefined ? {} : { allowMissing: options.allowMissing }),
    ...(options.expectedMissingAt === undefined ? {} : { expectedMissingAt: options.expectedMissingAt }),
    ...(options.expectedChain === undefined ? {} : { expectedChain: options.expectedChain }),
    ...(options.testHook ? { testHook: options.testHook } : {}),
  });
  const result = decodePromotionResponse(response);
  let identity: PromotionFsIdentity | null = null;
  if (result.identity !== null && result.identity !== undefined) {
    identity = decodePromotionIdentity(result.identity, "bound promotion prepared directory identity");
    const capability = (result.identity as Record<string, unknown>).capability;
    if (typeof capability === "string" && capability.length > 0) identity.capability = capability;
  }
  const rawMissingAt = result.missingAt;
  if (rawMissingAt !== null && rawMissingAt !== undefined && (!Number.isSafeInteger(rawMissingAt) || Number(rawMissingAt) < 0)) {
    throw new Error("invalid bound promotion directory missingAt");
  }
  if (!Array.isArray(result.chain)) throw new Error("invalid bound promotion directory chain");
  const chain = result.chain.map((value, index) => decodePromotionIdentity(value, `bound promotion directory chain ${index}`));
  return { identity, missingAt: rawMissingAt === null || rawMissingAt === undefined ? null : Number(rawMissingAt), chain };
}


/** Ensure an absolute directory chain through the native root descriptor. */
export async function boundPromotionEnsureDirectory(options: {
  path: string;
  expectedIdentity?: PromotionFsIdentity;
  capability?: string;
  trustedParent?: { path: string; identity: PromotionFsIdentity; name: string };
  /** Explicit descriptor-bound root transaction state; never inferred from a path. */
  provenance?: {
    name: string;
    parent: { path: string; identity: PromotionFsIdentity };
  };
  marker?: { name: string; content: Buffer; mode?: number };
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<PromotionFsIdentity> {
  const response = await coreClient.request({
    op: "promotion-bound-ensure-directory",
    path: options.path,
    ...(options.expectedIdentity ? { expectedIdentity: { dev: options.expectedIdentity.dev, ino: options.expectedIdentity.ino } } : {}),
    ...(options.capability ? { capability: options.capability } : {}),
    ...(options.trustedParent ? {
      trustedParent: {
        path: options.trustedParent.path,
        identity: { dev: options.trustedParent.identity.dev, ino: options.trustedParent.identity.ino },
        name: options.trustedParent.name,
        ...(options.trustedParent.identity.capability ? { capability: options.trustedParent.identity.capability } : {}),
      },
    } : {}),
    ...(options.provenance ? {
      provenance: {
        name: options.provenance.name,
        parent: {
          path: options.provenance.parent.path,
          identity: promotionIdentityPayload(options.provenance.parent.identity),
          ...(options.provenance.parent.identity.capability ? { capability: options.provenance.parent.identity.capability } : {}),
        },
      },
    } : {}),
    ...(options.marker ? {
      marker: {
        name: options.marker.name,
        content: options.marker.content.toString("base64"),
        ...(options.marker.mode === undefined ? {} : { mode: options.marker.mode }),
      },
    } : {}),
    ...(options.testHook ? { testHook: options.testHook } : {}),
  });
  const result = decodePromotionResponse(response);
  const identity = decodePromotionIdentity(result.identity, "bound promotion ensured directory identity");
  const capability = (result.identity as Record<string, unknown>).capability ?? result.capability;
  if (typeof capability === "string" && capability.length > 0) identity.capability = capability;
  return identity;
}


/** Create or open one directory below an identity-bound directory. */
export async function boundPromotionCreateDirectory(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
  components: string[];
  parentIdentity: PromotionFsIdentity;
  requireMissing?: boolean;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<PromotionFsIdentity> {
  const result = decodePromotionResponse(await coreClient.request({
    op: "promotion-bound-create-directory",
    ...options,
    rootIdentity: { dev: options.rootIdentity.dev, ino: options.rootIdentity.ino },
    ...(options.rootIdentity.capability ? { rootCapability: options.rootIdentity.capability } : {}),
  }));
  const identity = decodePromotionIdentity(result.identity, "bound promotion directory identity");
  const capability = (result.identity as Record<string, unknown>).capability;
  if (typeof capability === "string" && capability.length > 0) identity.capability = capability;
  return identity;
}


/** Copy a complete tree between two identity-bound directories. */
export async function boundPromotionCopyTree(options: {
  sourceRoot: string;
  sourceRootIdentity: PromotionFsIdentity;
  destinationRoot: string;
  destinationRootIdentity: PromotionFsIdentity;
  maxBytes?: number;
  maxWorkBytes?: number;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<{ bytes: number; entries: number; workBytes: number }> {
  const result = decodePromotionResponse(await coreClient.request({
    op: "promotion-bound-copy-tree",
    sourceRoot: options.sourceRoot,
    sourceRootIdentity: promotionIdentityPayload(options.sourceRootIdentity),
    ...(options.sourceRootIdentity.capability ? { sourceRootCapability: options.sourceRootIdentity.capability } : {}),
    destinationRoot: options.destinationRoot,
    destinationRootIdentity: promotionIdentityPayload(options.destinationRootIdentity),
    ...(options.destinationRootIdentity.capability ? { destinationRootCapability: options.destinationRootIdentity.capability } : {}),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxWorkBytes === undefined ? {} : { maxWorkBytes: options.maxWorkBytes }),
    ...(options.testHook ? { testHook: options.testHook } : {}),
  }));
  if (
    !Number.isSafeInteger(result.bytes) || Number(result.bytes) < 0
    || !Number.isSafeInteger(result.entries) || Number(result.entries) < 0
    || !Number.isSafeInteger(result.workBytes) || Number(result.workBytes) < 0
  ) {
    throw new Error("invalid bound promotion tree copy result");
  }
  return { bytes: Number(result.bytes), entries: Number(result.entries), workBytes: Number(result.workBytes) };
}


/** Write one bounded evidence/journal file through an identity-bound parent. */
export async function boundPromotionWriteFile(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
  components: string[];
  parentIdentity: PromotionFsIdentity;
  expectedDestination: BoundPromotionExpectedLeaf | BoundPromotionExpectedMissing;
  content: Buffer;
  mode?: number;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<BoundPromotionExpectedLeaf> {
  const response = await coreClient.request({
    op: "promotion-bound-write-file",
    root: options.root,
    rootIdentity: { dev: options.rootIdentity.dev, ino: options.rootIdentity.ino },
    ...(options.rootIdentity.capability ? { rootCapability: options.rootIdentity.capability } : {}),
    components: options.components,
    parentIdentity: options.parentIdentity,
    expectedDestination: options.expectedDestination,
    content: options.content.toString("base64"),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.testHook ? { testHook: options.testHook } : {}),
  });
  const result = decodePromotionResponse(response);
  return decodePromotionLeaf(result.leaf, "bound promotion written leaf");
}


/** Copy a regular file between identity-bound parents. */
export async function boundPromotionCopyFile(options: {
  sourceRoot: string;
  sourceRootIdentity: PromotionFsIdentity;
  sourceComponents: string[];
  sourceParentIdentity: PromotionFsIdentity;
  expectedSource: BoundPromotionExpectedLeaf;
  destinationRoot: string;
  destinationRootIdentity: PromotionFsIdentity;
  destinationComponents: string[];
  destinationParentIdentity: PromotionFsIdentity;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<BoundPromotionExpectedLeaf> {
  const response = await coreClient.request({
    op: "promotion-bound-copy-file",
    ...options,
    sourceRootIdentity: { dev: options.sourceRootIdentity.dev, ino: options.sourceRootIdentity.ino },
    ...(options.sourceRootIdentity.capability ? { sourceRootCapability: options.sourceRootIdentity.capability } : {}),
    destinationRootIdentity: { dev: options.destinationRootIdentity.dev, ino: options.destinationRootIdentity.ino },
    ...(options.destinationRootIdentity.capability ? { destinationRootCapability: options.destinationRootIdentity.capability } : {}),
    expectedSource: options.expectedSource,
    expectedDestination: { state: { type: "missing" } },
  });
  const result = decodePromotionResponse(response);
  return decodePromotionLeaf(result.leaf, "bound promotion copied leaf");
}


/** Create a symlink leaf below an identity-bound parent. */
export async function boundPromotionCreateSymlink(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
  components: string[];
  parentIdentity: PromotionFsIdentity;
  target: string;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<BoundPromotionExpectedLeaf> {
  const result = decodePromotionResponse(await coreClient.request({
    op: "promotion-bound-create-symlink",
    ...options,
    rootIdentity: { dev: options.rootIdentity.dev, ino: options.rootIdentity.ino },
    ...(options.rootIdentity.capability ? { rootCapability: options.rootIdentity.capability } : {}),
  }));
  return decodePromotionLeaf(result.leaf, "bound promotion symlink leaf");
}


/** Move a complete core-session bundle without pathname-following. */
export async function boundPromotionInstallDirectory(options: {
  sourceRoot: string;
  sourceRootIdentity: PromotionFsIdentity;
  sourceComponents: string[];
  sourceParentIdentity: PromotionFsIdentity;
  expectedSource: { identity: PromotionFsIdentity; mode: number };
  destinationRoot: string;
  destinationRootIdentity: PromotionFsIdentity;
  destinationComponents: string[];
  destinationParentIdentity: PromotionFsIdentity;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<{ outcome: "applied" | "conflict-after-mutation"; durable: boolean; error: string | null }> {
  const result = decodePromotionResponse(await coreClient.request({
    op: "promotion-bound-install-directory",
    ...options,
    sourceRootIdentity: { dev: options.sourceRootIdentity.dev, ino: options.sourceRootIdentity.ino },
    ...(options.sourceRootIdentity.capability ? { sourceRootCapability: options.sourceRootIdentity.capability } : {}),
    destinationRootIdentity: { dev: options.destinationRootIdentity.dev, ino: options.destinationRootIdentity.ino },
    ...(options.destinationRootIdentity.capability ? { destinationRootCapability: options.destinationRootIdentity.capability } : {}),
  }));
  if ((result.outcome !== "applied" && result.outcome !== "conflict-after-mutation") || typeof result.durable !== "boolean" || (result.error !== null && typeof result.error !== "string")) {
    throw new Error("invalid bound promotion directory install result");
  }
  return { outcome: result.outcome, durable: result.durable, error: result.error as string | null };
}


/** Remove a journal operation only while its parent/leaf identities remain bound. */
export async function boundPromotionRemoveTree(options: {
  root: string;
  rootIdentity: PromotionFsIdentity;
  components: string[];
  parentIdentity: PromotionFsIdentity;
  expectedIdentity: PromotionFsIdentity;
  testHook?: { stage: string; readyPath: string; releasePath: string };
}): Promise<void> {
  const result = decodePromotionResponse(await coreClient.request({
    op: "promotion-bound-remove-tree",
    ...options,
    rootIdentity: { dev: options.rootIdentity.dev, ino: options.rootIdentity.ino },
    ...(options.rootIdentity.capability ? { rootCapability: options.rootIdentity.capability } : {}),
  }));
  if (result.removed !== true) throw new Error("bound promotion cleanup did not remove its operation");
}
