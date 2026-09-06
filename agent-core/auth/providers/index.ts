import type { ProviderId, ProviderDefinition } from "./types.ts";
import { anthropic } from "./anthropic.ts";
import { openai } from "./openai.ts";
import { openaiCodex } from "./openai-codex.ts";
import { githubCopilot } from "./github-copilot.ts";
import { xai } from "./xai.ts";
import { google } from "./google.ts";
import { openrouter } from "./openrouter.ts";
import { opencodeGo } from "./opencode-go.ts";
import { opencodeZen } from "./opencode-zen.ts";

const providers: Record<ProviderId, ProviderDefinition> = {
  "anthropic": anthropic,
  "openai": openai,
  "openai-codex": openaiCodex,
  "github-copilot": githubCopilot,
  "xai": xai,
  "google": google,
  "openrouter": openrouter,
  "opencode-go": opencodeGo,
  "opencode-zen": opencodeZen,
};

export function providerDefinition(id: ProviderId): ProviderDefinition {
  return providers[id];
}
