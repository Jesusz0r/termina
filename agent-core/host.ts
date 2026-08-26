/**
 * Termina host adapter for agent-core.
 *
 * Same sidecar file names as the Pi bridge: ack, prompt payload,
 * verify/edits/mine/mailbox context, startup-control. The parser stays
 * electron/sidecar.ts. This module is the kernel writer of that protocol.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HAS_UNCHECKED_PLAN_TASK } from "../shared/plan-task.ts";

const ACK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const CONTEXT_FILES = ["verify", "edits", "mine", "mailbox"] as const;
const PLAN_TEXT_CAP = 4000;

export function ackPath(eventsDir: string, terminalId: string, requestId: string): string {
  return join(eventsDir, `ack-${terminalId}-${requestId}.json`);
}

export async function waitForAck(
  eventsDir: string,
  terminalId: string,
  requestId: string,
  timeoutMs: number,
  bridgeId: string,
  opts?: { shouldStop?: () => boolean },
): Promise<Record<string, unknown> | null> {
  if (!eventsDir || !terminalId || !ACK_ID.test(requestId) || !ACK_ID.test(terminalId)) return null;
  const target = ackPath(eventsDir, terminalId, requestId);
  const claimed = `${target}.claimed-${bridgeId}`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (opts?.shouldStop?.()) return null;
    try {
      renameSync(target, claimed);
      try {
        const raw = readFileSync(claimed, "utf8");
        return JSON.parse(raw) as Record<string, unknown>;
      } finally {
        rmSync(claimed, { force: true });
      }
    } catch {
      /* not written yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

export function readContextFiles(eventsDir: string, terminalId: string): string {
  if (!eventsDir || !terminalId) return "";
  const parts: string[] = [];
  for (const kind of CONTEXT_FILES) {
    const path = join(eventsDir, `${kind}-${terminalId}.md`);
    try {
      const text = readFileSync(path, "utf8");
      if (text) parts.push(text);
    } catch {
      /* missing context file */
    }
  }
  return parts.join("\n\n---\n\n");
}

export function writePromptPayload(
  eventsDir: string,
  terminalId: string,
  fileName: string,
  payload: { prompt: string; context: string; images?: unknown[] },
): string | null {
  if (!eventsDir || !terminalId || !fileName || fileName.includes("/") || fileName.includes("\\")) return null;
  try {
    mkdirSync(eventsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(eventsDir, fileName),
      JSON.stringify({ prompt: payload.prompt, images: payload.images ?? [], context: payload.context }),
      { mode: 0o600 },
    );
    return fileName;
  } catch {
    return null;
  }
}

export function promptFileName(terminalId: string, bridgeId: string, stamp: string): string {
  return `prompt-${terminalId}-${bridgeId.slice(0, 8)}-${stamp}.json`;
}

export type StartupControl = {
  opId: string;
  action: string;
  text?: string;
  content?: unknown;
};

function parseControl(raw: string): StartupControl | null {
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  const obj = rec as Record<string, unknown>;
  return {
    opId: typeof obj.opId === "string" ? obj.opId : "",
    action: typeof obj.action === "string" ? obj.action : "",
    text: typeof obj.text === "string" ? obj.text : undefined,
    content: obj.content,
  };
}

function claimControlFile(path: string, bridgeId: string): StartupControl | null {
  const claimed = `${path}.claimed-${bridgeId}`;
  try {
    renameSync(path, claimed);
  } catch {
    return null;
  }
  try {
    return parseControl(readFileSync(claimed, "utf8"));
  } catch {
    return null;
  } finally {
    rmSync(claimed, { force: true });
  }
}

/** Consume startup-control-<id>.json, then startup-control.json. */
export function consumeStartupControl(
  eventsDir: string,
  terminalId: string,
  bridgeId: string,
): StartupControl | null {
  if (!eventsDir || !terminalId) return null;
  return (
    claimControlFile(join(eventsDir, `startup-control-${terminalId}.json`), bridgeId) ??
    claimControlFile(join(eventsDir, "startup-control.json"), bridgeId)
  );
}

export function structuredStartupText(control: StartupControl): string {
  if (Array.isArray(control.content)) {
    const parts: string[] = [];
    for (const item of control.content) {
      if (typeof item === "string" && item) parts.push(item);
      else if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        const text = (item as { text: string }).text;
        if (text) parts.push(text);
      }
    }
    return parts.join("\n");
  }
  return control.text ?? "";
}

export function visibleAssistantText(blocks: Array<{ type?: string; text?: string }>): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "thinking" || b.type === "reasoning" || b.type === "redacted_thinking") continue;
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

export function firstPlanText(text: string): string | null {
  if (!text.trim() || !HAS_UNCHECKED_PLAN_TASK.test(text)) return null;
  return text.slice(0, PLAN_TEXT_CAP);
}


