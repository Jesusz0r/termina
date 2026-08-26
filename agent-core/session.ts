/**
 * Append-only agent-core session JSONL.
 *
 * Worldlines slices this format without importing the kernel loop.
 * Revisions stay in the prefix: replay on the candidate applies them.
 */
import { existsSync, renameSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;

/** Filesystem-safe stamp for a rotated session file name. */
export function sessionRotateStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Move a non-empty session jsonl aside so /clear can start a fresh file
 * at the same path. Empty or missing files stay as they are.
 */
export function rotateSessionFile(path: string, now = Date.now()): { ok: true; aside: string | null } | { ok: false; error: string } {
  try {
    if (!existsSync(path)) return { ok: true, aside: null };
    const info = statSync(path);
    if (!info.isFile() || info.size === 0) return { ok: true, aside: null };
    const dir = dirname(path);
    const name = basename(path);
    const stem = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
    const stamp = sessionRotateStamp(now);
    let aside = join(dir, `${stem}-${stamp}.jsonl`);
    let n = 0;
    while (existsSync(aside)) {
      n += 1;
      if (n > 20) return { ok: false, error: "could not pick a rotate name" };
      aside = join(dir, `${stem}-${stamp}-${n}.jsonl`);
    }
    renameSync(path, aside);
    return { ok: true, aside };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function sliceSessionText(
  text: string,
  throughSeq: number,
): { ok: true; text: string; kept: number } | { ok: false; error: string } {
  if (!Number.isInteger(throughSeq) || throughSeq < 0) return { ok: false, error: "invalid throughSeq" };
  if (throughSeq === 0) return { ok: true, text: "", kept: 0 };
  const rawLines = text.split("\n");
  const lines = rawLines.filter((line, i) => {
    if (line.trim() === "") return false;
    if (i === rawLines.length - 1) {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    }
    return true;
  });
  const kept: string[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    let rec: { storageSeq?: unknown };
    try {
      rec = JSON.parse(line) as { storageSeq?: unknown };
    } catch {
      return { ok: false, error: "malformed session record" };
    }
    if (typeof rec.storageSeq !== "number" || !Number.isInteger(rec.storageSeq) || rec.storageSeq < 1) {
      return { ok: false, error: "invalid storageSeq" };
    }
    if (seen.has(rec.storageSeq)) return { ok: false, error: "duplicate storageSeq" };
    seen.add(rec.storageSeq);
    if (rec.storageSeq <= throughSeq) kept.push(line);
  }
  return { ok: true, text: kept.length > 0 ? `${kept.join("\n")}\n` : "", kept: kept.length };
}

export async function writeForkedSession(
  sourcePath: string,
  destPath: string,
  throughSeq: number,
): Promise<{ ok: true; kept: number } | { ok: false; error: string }> {
  try {
    await mkdir(dirname(destPath), { recursive: true, mode: 0o700 });
    if (throughSeq === 0) {
      await writeFile(destPath, "", { mode: 0o600 });
      return { ok: true, kept: 0 };
    }
    const buf = await readFile(sourcePath);
    if (buf.length > MAX_SESSION_FILE_BYTES) return { ok: false, error: "session file is too large" };
    const sliced = sliceSessionText(buf.toString("utf8"), throughSeq);
    if (!sliced.ok) return sliced;
    await writeFile(destPath, sliced.text, { mode: 0o600 });
    await copySessionImageFiles(sourcePath, destPath);
    return { ok: true, kept: sliced.kept };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const SESSION_IMAGE = /-img-[1-9][0-9]{0,3}\.(png|jpe?g|webp|gif)$/;

/** Copy sidecar image files that sit next to a session jsonl. */
export async function copySessionImageFiles(sourcePath: string, destPath: string): Promise<void> {
  const srcDir = dirname(sourcePath);
  const destDir = dirname(destPath);
  if (srcDir === destDir) return;
  let names: string[] = [];
  try {
    names = await readdir(srcDir);
  } catch {
    return;
  }
  await mkdir(destDir, { recursive: true, mode: 0o700 });
  for (const name of names) {
    if (!SESSION_IMAGE.test(name)) continue;
    try {
      await copyFile(join(srcDir, name), join(destDir, name));
    } catch {
      /* skip one image; the jsonl copy still stands */
    }
  }
}
