import { afterEach, describe, expect, it } from "vitest";

import { parseModelRef, pickHeaders } from "../../../agent-core/auth.ts";
import { testLoopbackOverride } from "../../../agent-core/auth/endpoints.ts";
import {
  acceptedContextWindow,
  clampEffortLevel,
  supportedEffortLevels,
} from "../../../agent-core/models/capabilities.ts";
import { relayCompletionsFamily } from "../../../agent-core/models/families/relay.ts";
import { gptVersion, isGpt56OrLaterModel, oSeriesModel } from "../../../agent-core/models/families/identity.ts";
import { catalogFetchAllowed, parseModelsPayload } from "../../../agent-core/models.ts";
import { responsesBody } from "../../../agent-core/openai-compat.ts";
import { McpTransportError, normalizeInputSchema, normalizeMcpDiscovery } from "../../../agent-core/mcp.ts";
import { isSessionBudgetExceeded, sessionBudgetExceeded } from "../../../agent-core/session.ts";
import { READ_TOOLS } from "../../../agent-core/tool-dispatch.ts";
import { utf8TextPrefix } from "../../../agent-core/tool-output.ts";
import { revisions } from "../../../agent-core/trace/normalize.ts";

const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
});

describe("agent-core #262–#271 / #256", () => {
  it("#262 parseModelRef fails closed on unknown ids", () => {
    expect(parseModelRef("mystery-model")).toBeNull();
    expect(parseModelRef("vendor/unknown-id")).toBeNull();
    expect(parseModelRef("")).toBeNull();
    expect(parseModelRef("grok-4.6")).toEqual({ provider: "xai", model: "grok-4.6" });
    expect(parseModelRef("mystery-model", "openai")).toEqual({ provider: "openai", model: "mystery-model" });
  });

  it("#263 accepts documented small windows and rejects garbage", () => {
    expect(acceptedContextWindow(4_000)).toBe(4_000);
    expect(acceptedContextWindow(100)).toBe(100);
    expect(acceptedContextWindow(0)).toBeUndefined();
    expect(acceptedContextWindow(Number.NaN)).toBeUndefined();
    expect(acceptedContextWindow(-1)).toBeUndefined();
    expect(acceptedContextWindow(0.9)).toBeUndefined();
    expect(parseModelsPayload([{ id: "qwen-tiny", context_length: 4096 }], "opencode-go")).toEqual([
      { id: "qwen-tiny", context: 4096 },
    ]);
  });

  it("#264 catalog reasoning levels replace static effort maps", () => {
    const proto = "openai-codex-responses" as const;
    const staticLevels = supportedEffortLevels("openai-codex", "gpt-5.6-sol", proto);
    expect(staticLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(supportedEffortLevels("openai-codex", "gpt-5.6-sol", proto, ["none", "low", "medium"])).toEqual([
      "off",
      "low",
      "medium",
    ]);
    expect(supportedEffortLevels("openai-codex", "gpt-5.6-sol", proto, ["low", "ultra"])).toEqual(["low"]);
    expect(clampEffortLevel("openai-codex", "gpt-5.6-sol", "high", proto, ["none", "low", "medium"])).toBe("medium");
  });

  it("#265 relay completions families no longer overlap glm/qwen/muse-spark", () => {
    expect(relayCompletionsFamily("glm-5.1")).toBe(false);
    expect(relayCompletionsFamily("qwen3.7-max")).toBe(false);
    expect(relayCompletionsFamily("muse-spark-1.3")).toBe(false);
    expect(relayCompletionsFamily("deepseek-v4-pro")).toBe(true);
    expect(supportedEffortLevels("opencode-zen", "qwen3.7-max", "openai-completions")).toEqual(["off"]);
    expect(supportedEffortLevels("opencode-zen", "muse-spark-1.3", "openai-completions")).toEqual(["off"]);
    expect(supportedEffortLevels("opencode-zen", "deepseek-v4-pro", "openai-completions")).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(supportedEffortLevels("opencode-zen", "glm-5.1", "openai-completions")).toEqual(["high", "max"]);
  });

  it("#266 identity, Codex maxTokens, and loopback share one owner each", () => {
    expect(gptVersion("gpt-5.6-sol")).toEqual({ major: 5, minor: 6 });
    expect(isGpt56OrLaterModel("gpt-5.6-sol")).toBe(true);
    expect(isGpt56OrLaterModel("gpt-5.5")).toBe(false);
    expect(oSeriesModel("o3-mini")).toBe(true);
    expect(oSeriesModel("vendor/o4")).toBe(true);
    const openai = responsesBody("gpt-5.6-sol", "sys", [], [], { provider: "openai", maxTokens: 1024 });
    expect(openai.max_output_tokens).toBe(1024);
    const codex = responsesBody("gpt-5.6-sol", "sys", [], [], { provider: "openai-codex", maxTokens: 1024 });
    expect(codex.max_output_tokens).toBeUndefined();

    setEnv("TERMINA_CORE_TEST", "1");
    setEnv("TERMINA_TEST_MODELS_URL", "http://127.999.999.999/catalog");
    expect(testLoopbackOverride("TERMINA_TEST_MODELS_URL")).toBeUndefined();
    expect(catalogFetchAllowed()).toBe(false);
    setEnv("TERMINA_TEST_MODELS_URL", "http://127.0.0.1:9/catalog#leak");
    expect(testLoopbackOverride("TERMINA_TEST_MODELS_URL")).toBeUndefined();
    setEnv("TERMINA_TEST_MODELS_URL", "http://127.0.0.1:9/catalog");
    expect(testLoopbackOverride("TERMINA_TEST_MODELS_URL")).toBe("http://127.0.0.1:9/catalog");
    expect(catalogFetchAllowed()).toBe(true);
  });

  it("#267 unsourced Anthropic tokens do not sniff OAuth markers", () => {
    expect(pickHeaders("sk-ant-oat-secret")["x-api-key"]).toBe("sk-ant-oat-secret");
    expect(pickHeaders("sk-ant-oat-secret").authorization).toBeUndefined();
    expect(pickHeaders("sk-ant-oat-secret", { type: "oauth" }).authorization).toBe("Bearer sk-ant-oat-secret");
    expect(pickHeaders("gateway", { envName: "ANTHROPIC_AUTH_TOKEN" }).authorization).toBe("Bearer gateway");
  });

  it("#269 typed session budget and MCP transport why", () => {
    const exceeded = sessionBudgetExceeded("session bundle exceeds MAX_SESSION_BUNDLE_BYTES");
    expect(isSessionBudgetExceeded(exceeded)).toBe(true);
    expect(isSessionBudgetExceeded({ ok: false, error: "session bundle exceeds MAX_SESSION_BUNDLE_BYTES" })).toBe(false);
    const timeout = new McpTransportError("timeout", "mcp demo timed out");
    expect(timeout.why).toBe("timeout");
    expect(timeout instanceof McpTransportError).toBe(true);
    const interrupted = new McpTransportError("interrupted", "interrupted");
    expect(interrupted.why).toBe("interrupted");
  });

  it("#270 observational set and utf8 owner stay singular", () => {
    expect([...READ_TOOLS].sort()).toEqual(["fetch", "glob", "grep", "read_file"]);
    expect(utf8TextPrefix("ééé", 2)).toBe("é");
  });

  it("#271 revisions() accepts only the writer shape", () => {
    expect(revisions({ count: 2, kinds: ["compact"] })).toEqual({ count: 2, kinds: ["compact"] });
    expect(revisions(undefined)).toEqual({ count: null, kinds: [] });
  });

  it("#256 malformed MCP schemas fail instead of inventing {}", () => {
    expect(normalizeInputSchema({ type: "string" })).toEqual({
      ok: false,
      error: "mcp schema type must be object, got string",
    });
    const discovered = normalizeMcpDiscovery([
      {
        name: "bad",
        description: "bad",
        input_schema: { type: "string" },
        server: "s",
        original: "bad",
      },
    ]);
    expect(discovered.tools).toEqual([]);
    expect(discovered.conflicts[0]).toMatch(/mcp schema invalid/);
  });
});
