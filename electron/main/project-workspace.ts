/**
 * Pure project/workspace bookkeeping (ids, path containment, session slugs).
 * Open/close, leases, and snapshot orchestration stay on TerminaApp.
 */
import { isAbsolute, relative, resolve } from "node:path";

let workspaceSeq = 0;
let projectSeq = 0;

export function nextWorkspaceId(): string {
  return `ws-${++workspaceSeq}`;
}

export function nextProjectId(): string {
  return `proj-${++projectSeq}`;
}

/** True when `target` resolves inside `parent`. Neither path needs to exist. */
export function pathInside(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Sessions directory name for a project path. One sanitizer for picker and install. */
export function sanitizeSessionDir(absPath: string): string {
  const p = absPath.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "").replace(/[/\\:]/g, "-");
  return "--" + p + "--";
}

export function primaryWorkspaceOf<T extends { primary: boolean }>(workspaces: Iterable<T>): T | null {
  for (const ws of workspaces) if (ws.primary) return ws;
  return null;
}

/** Watcher-less workspace record. TerminaApp starts the watcher and recording. */
export function newWorkspaceState(root: string, primary: boolean): {
  id: string;
  root: string;
  primary: boolean;
  generation: number;
  writerId: null;
  watcher: null;
  terminalIds: Set<string>;
  lastStateCommit: null;
  momentCapturePromise: null;
  momentUnsettledRetries: number;
  lastReseedMs: number;
  retainedBlobBytes: number;
  indexReady: null;
  indexDone: false;
  recordError: null;
  changeLines: Map<string, number[]>;
} {
  return {
    id: nextWorkspaceId(),
    root,
    primary,
    generation: 0,
    writerId: null,
    watcher: null,
    terminalIds: new Set(),
    lastStateCommit: null,
    momentCapturePromise: null,
    momentUnsettledRetries: 0,
    lastReseedMs: 0,
    retainedBlobBytes: 0,
    indexReady: null,
    indexDone: false,
    recordError: null,
    changeLines: new Map(),
  };
}
