/**
 * Conversation resume for external CLI tabs. Only CLIs whose hook field and
 * resume flag are verified are listed; the rest reopen a new conversation.
 *
 * - claude: hook `session_id`, `claude --resume <id>` (code.claude.com/docs/en/hooks)
 * - codex: hook `session_id`, `codex resume <id>` (learn.chatgpt.com/docs/hooks)
 * - grok: hook `sessionId`, `grok --resume <id>` (docs.x.ai/build/features/hooks)
 * - gemini (agy): hook `conversationId`, `agy --conversation <id>`
 *   (antigravity.google/docs/hooks, `agy --help`)
 */
import { isRecord } from "../../shared/guards.ts";
import type { ExternalCli } from "../../shared/types.ts";

const RESUME: Partial<Record<ExternalCli, { field: string; args: (id: string) => string[] }>> = {
  claude: { field: "session_id", args: (id) => ["--resume", id] },
  codex: { field: "session_id", args: (id) => ["resume", id] },
  grok: { field: "sessionId", args: (id) => ["--resume", id] },
  gemini: { field: "conversationId", args: (id) => ["--conversation", id] },
};

/** A leading letter or digit keeps a saved id from ever parsing as a flag. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isExternalSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** The conversation a hook payload belongs to, when this CLI can resume it. */
export function hookSessionId(cli: ExternalCli, payload: unknown): string | null {
  const field = RESUME[cli]?.field;
  if (!field || !isRecord(payload)) return null;
  const value = payload[field];
  return isExternalSessionId(value) ? value : null;
}

/** Launch args that reopen a saved conversation. Empty when the CLI cannot. */
export function externalCliResumeArgs(cli: ExternalCli, sessionId: string | null | undefined): string[] {
  const resume = RESUME[cli];
  return resume && isExternalSessionId(sessionId) ? resume.args(sessionId) : [];
}
