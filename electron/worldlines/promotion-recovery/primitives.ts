/**
 * Promotion primitives: async/process helpers and shared checks.
 *
 * Owns bounded waits, process identity, hashing, the promotion
 * transaction tail, and small shared validators. Split from
 * promotion-recovery.ts (issue #38).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { isAbsolute } from "node:path";


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

export const EMPTY_PROMOTION_HASH = sha256Hex(Buffer.alloc(0));

export const SHA256_HEX = /^[0-9a-f]{64}$/;



export function statIdentityEqual(a: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }, b: { dev: number; ino: number; mode: number; size: number; mtimeMs: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs;
}


export function promotionNoFollowFlag(): number {
  const flag = (fsConstants as Record<string, unknown>).O_NOFOLLOW;
  if (typeof flag !== "number" || flag === 0) throw new Error("promotion recovery requires O_NOFOLLOW support");
  return flag;
}


export function exactObjectKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}


export function isSafePromotionRelativePath(rel: string): boolean {
  return rel.length > 0 && rel !== "." && rel.indexOf("\0") === -1 && !isAbsolute(rel) && !rel.startsWith("/") && !rel.split(/[\\/]/).includes("..");
}
