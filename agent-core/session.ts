/**
 * Append-only agent-core session JSONL.
 *
 * Worldlines slices this format without importing the kernel loop.
 * Revisions stay in the prefix: replay on the candidate applies them.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;

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
    return { ok: true, kept: sliced.kept };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
