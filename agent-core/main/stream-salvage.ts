/**
 * Salvage a failed provider stream into request-safe history blocks.
 *
 * Incomplete tool JSON and unsigned thinking are dropped so the next prompt
 * can continue without breaking tool pairing or prompt projection.
 */

export type SalvageBlock = Record<string, unknown> & { type: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Keep only blocks that can sit in history and be sent on the next request. */
export function salvageAssistantBlocks(blocks: readonly SalvageBlock[]): SalvageBlock[] {
  const out: SalvageBlock[] = [];
  for (const block of blocks) {
    if (!isPlainObject(block) || typeof block.type !== "string") continue;
    if (block.type === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      if (text) out.push({ type: "text", text });
      continue;
    }
    if (block.type === "thinking") {
      if (typeof block.signature !== "string" || !block.signature) continue;
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      out.push({ type: "thinking", thinking, signature: block.signature });
      continue;
    }
    if (block.type !== "tool_use") continue;
    const id = typeof block.id === "string" ? block.id.trim() : "";
    const name = typeof block.name === "string" ? block.name.trim() : "";
    if (!id || !name || !isPlainObject(block.input)) continue;
    out.push({ type: "tool_use", id, name, input: block.input });
  }
  return out;
}
