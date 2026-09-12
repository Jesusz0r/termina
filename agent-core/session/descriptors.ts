/**
 * Descriptor-bound directory/segment identity primitives.
 *
 * Owns stable device/inode/version identity, directory anchors, segment
 * validation, and directory fsync. Split from agent-core/session.ts (issue #38).
 */
import { closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, openSync, type BigIntStats } from "node:fs";
import { basename, dirname } from "node:path";
import { errMsg } from "./primitives.ts";
import type { SessionResult } from "./primitives.ts";


/**
 * Persist a directory entry update when the host supports directory fsync.
 * Linux and macOS expose slightly different unsupported-operation errors, so
 * only those known capability errors are treated as a successful no-op;
 * permission, lookup, and descriptor failures remain fatal.
 */
export function fsyncDirectory(path: string): SessionResult {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    return fsyncDirectoryDescriptor(fd);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* the directory descriptor may already be closed by the host */
      }
    }
  }
}


export function fsyncDirectoryDescriptor(fd: number): SessionResult {
  try {
    fsyncSync(fd);
    return { ok: true };
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EISDIR") {
      return { ok: true };
    }
    return { ok: false, error: errMsg(err) };
  }
}


export function fsyncDirectoryAndParent(path: string): SessionResult {
  const directory = fsyncDirectory(path);
  if (!directory.ok) return directory;
  return fsyncDirectory(dirname(path));
}


export type StableIdentity = {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
};


export type DirectoryAnchor = {
  path: string;
  fd: number;
  identity: StableIdentity;
};


export type OpenSessionSegment = {
  path: string;
  name: string;
  fd: number;
  size: number;
  identity: StableIdentity;
  allowTruncatedTail: boolean;
};


export type OpenSessionBundle = {
  anchors: DirectoryAnchor[];
  segments: OpenSessionSegment[];
};


export function statIdentity(info: BigIntStats): StableIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    mode: info.mode,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
    birthtimeNs: info.birthtimeNs,
  };
}


function sameObject(left: StableIdentity, right: StableIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}


function sameObjectType(left: StableIdentity, right: StableIdentity): boolean {
  const typeMask = 0o170000n;
  return sameObject(left, right) && (left.mode & typeMask) === (right.mode & typeMask);
}


export function sameVersion(left: StableIdentity, right: StableIdentity): boolean {
  return (
    sameObject(left, right) &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}


function sameDirectory(left: StableIdentity, right: StableIdentity): boolean {
  return sameObject(left, right) && left.mode === right.mode;
}


export function noFollowFlags(base: number): number {
  return base | (typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0);
}


export function anchoredChildPath(anchor: DirectoryAnchor, name: string, fallback: string): string {
  if (process.platform === "linux" && !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..") {
    return `/proc/self/fd/${anchor.fd}/${name}`;
  }
  return fallback;
}


export function openDirectoryAnchor(path: string, label: string, descriptorPath = path): SessionResult<{ anchor: DirectoryAnchor }> {
  let fd: number | null = null;
  try {
    const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
    fd = openSync(descriptorPath, noFollowFlags(fsConstants.O_RDONLY | directoryFlag));
    const opened = fstatSync(fd, { bigint: true });
    const atPath = lstatSync(path, { bigint: true });
    if (!opened.isDirectory() || atPath.isSymbolicLink() || !atPath.isDirectory()) {
      throw new Error(`${label} is not a stable directory`);
    }
    const identity = statIdentity(opened);
    if (!sameDirectory(identity, statIdentity(atPath))) throw new Error(`${label} changed while it was opened`);
    return { ok: true, anchor: { path, fd, identity } };
  } catch (err) {
    if (fd !== null) closeSync(fd);
    return { ok: false, error: errMsg(err) };
  }
}


export function validateDirectoryAnchor(anchor: DirectoryAnchor): SessionResult {
  try {
    const opened = fstatSync(anchor.fd, { bigint: true });
    const atPath = lstatSync(anchor.path, { bigint: true });
    if (!opened.isDirectory() || atPath.isSymbolicLink() || !atPath.isDirectory()) {
      return { ok: false, error: `session directory changed: ${anchor.path}` };
    }
    if (!sameDirectory(anchor.identity, statIdentity(opened)) || !sameDirectory(anchor.identity, statIdentity(atPath))) {
      return { ok: false, error: `session directory changed: ${anchor.path}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}


export function validateReopenedDirectoryIdentity(
  anchor: DirectoryAnchor,
  parent: DirectoryAnchor,
  exactMode: boolean,
): SessionResult {
  let reopenedFd: number | null = null;
  try {
    const retained = fstatSync(anchor.fd, { bigint: true });
    const descriptorPath = anchoredChildPath(parent, basename(anchor.path), anchor.path);
    const directoryFlag = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
    reopenedFd = openSync(descriptorPath, noFollowFlags(fsConstants.O_RDONLY | directoryFlag));
    const reopened = fstatSync(reopenedFd, { bigint: true });
    const atPath = lstatSync(anchor.path, { bigint: true });
    if (!retained.isDirectory() || !reopened.isDirectory() || atPath.isSymbolicLink() || !atPath.isDirectory()) {
      return { ok: false, error: `session directory changed: ${anchor.path}` };
    }
    const matches = exactMode ? sameDirectory : sameObjectType;
    if (
      !matches(anchor.identity, statIdentity(retained)) ||
      !matches(anchor.identity, statIdentity(reopened)) ||
      !matches(anchor.identity, statIdentity(atPath))
    ) {
      return { ok: false, error: `session directory changed: ${anchor.path}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  } finally {
    if (reopenedFd !== null) closeSync(reopenedFd);
  }
}


export function validateSegment(segment: OpenSessionSegment): SessionResult {
  try {
    const opened = fstatSync(segment.fd, { bigint: true });
    const atPath = lstatSync(segment.path, { bigint: true });
    if (!opened.isFile() || atPath.isSymbolicLink() || !atPath.isFile()) {
      return { ok: false, error: `session segment changed: ${segment.name}` };
    }
    if (!sameVersion(segment.identity, statIdentity(opened)) || !sameVersion(segment.identity, statIdentity(atPath))) {
      return { ok: false, error: `session segment changed: ${segment.name}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
}


export function closeOpenSessionBundle(bundle: OpenSessionBundle): void {
  for (const segment of bundle.segments) {
    try {
      closeSync(segment.fd);
    } catch {
      /* already closed */
    }
  }
  for (const anchor of bundle.anchors) {
    try {
      closeSync(anchor.fd);
    } catch {
      /* already closed */
    }
  }
}
