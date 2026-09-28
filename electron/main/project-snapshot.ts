import { basename } from "node:path";

/** Bound for one project snapshot context file (tree listing for a turn). */
export const MAX_PROJECT_SNAPSHOT_BYTES = 12 * 1024;

/** Keep a complete breadth-first prefix, without a clock or partial paths. */
export function formatProjectSnapshot(
  root: string,
  snapshot: { entries: string[]; truncated: boolean },
): Buffer | null {
  if (snapshot.entries.length === 0) return null;
  const header =
    `## Project snapshot — \`${basename(root)}\`\n\n` +
    "Top-level tree first; `…(truncated)` means the listing hit a bound.\n" +
    "A hint only — file tools see live state.\n\n" +
    "```text\n";
  const truncatedFooter = "…(truncated)\n```\n";
  const full = Buffer.from(header + snapshot.entries.join("\n") + "\n" + (snapshot.truncated ? truncatedFooter : "```\n"));
  if (full.byteLength <= MAX_PROJECT_SNAPSHOT_BYTES) return full;

  // Reserve the truncation marker before fitting complete paths. Removing a
  // fixed batch can discard every entry in a small tree with long paths.
  let bytes = Buffer.byteLength(header + truncatedFooter);
  const lines: string[] = [];
  for (const entry of snapshot.entries) {
    const lineBytes = Buffer.byteLength(entry) + 1;
    if (bytes + lineBytes > MAX_PROJECT_SNAPSHOT_BYTES) break;
    lines.push(entry);
    bytes += lineBytes;
  }
  return lines.length > 0 ? Buffer.from(header + lines.join("\n") + "\n" + truncatedFooter) : null;
}
