import type { ProviderProtocol } from "./types.ts";
import { modelLeaf } from "../../models/families/identity.ts";

export function protocolEndpoint(baseUrl: string, model: string, proto: ProviderProtocol, stream = true): string {
  const base = baseUrl.replace(/\/$/, "");
  if (proto === "anthropic-messages") {
    if (base.endsWith("/v1")) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (proto === "openai-codex-responses") {
    if (base.endsWith("/codex/responses")) return base;
    if (base.endsWith("/codex")) return `${base}/responses`;
    return `${base}/codex/responses`;
  }
  if (proto === "openai-responses") {
    if (base.endsWith("/responses")) return base;
    return `${base}/responses`;
  }
  if (proto === "google-generate") {
    const leaf = modelLeaf(model) || "gemini-3.7-flash";
    return stream
      ? `${base}/models/${leaf}:streamGenerateContent?alt=sse`
      : `${base}/models/${leaf}:generateContent`;
  }
  return `${base}/chat/completions`;
}
