import { afterEach, describe, expect, it } from "vitest";
import * as endpoints from "../../../agent-core/auth/endpoints.ts";
import { parseAuthCommand } from "../../../agent-core/auth/login.ts";
import { SUPPORTED_PROVIDERS } from "../../../agent-core/auth/providers/types.ts";

const BROWSER_OAUTH_IDS = ["openai-codex", "openrouter"] as const;
const TOKEN_OAUTH_IDS = ["openai-codex", "openrouter", "xai"] as const;

describe("OAuth URL helpers (#369)", () => {
  afterEach(() => {
    delete process.env.TERMINA_TEST_AUTHORIZE_URL;
    delete process.env.TERMINA_TEST_TOKEN_URL;
    delete process.env.TERMINA_TEST_DEVICE_URL;
  });

  it("authorizeUrl switches on the browser OAuth ids and throws for the rest", () => {
    expect(endpoints.authorizeUrl("openai-codex")).toBe("https://auth.openai.com/oauth/authorize");
    expect(endpoints.authorizeUrl("openrouter")).toBe("https://openrouter.ai/auth");
    for (const id of SUPPORTED_PROVIDERS) {
      if ((BROWSER_OAUTH_IDS as readonly string[]).includes(id)) continue;
      expect(() => endpoints.authorizeUrl(id), id).toThrow(`no authorize URL for ${id}`);
    }
  });

  it("tokenUrl does not default to Anthropic and throws for key-only ids", () => {
    expect(endpoints.tokenUrl("openai-codex")).toBe("https://auth.openai.com/oauth/token");
    expect(endpoints.tokenUrl("openrouter")).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(endpoints.tokenUrl("xai")).toBe("https://auth.x.ai/oauth2/token");
    for (const id of SUPPORTED_PROVIDERS) {
      if ((TOKEN_OAUTH_IDS as readonly string[]).includes(id)) continue;
      expect(() => endpoints.tokenUrl(id), id).toThrow(`no token URL for ${id}`);
    }
  });

  it("renames the xAI-only device helper", () => {
    expect(endpoints.xaiDeviceUrl()).toBe("https://auth.x.ai/oauth2/device/code");
    expect("deviceUrl" in endpoints).toBe(false);
  });

  it("login offers browser OAuth only for the remaining authorize ids", () => {
    expect(parseAuthCommand("/login anthropic")).toEqual({
      cmd: "login",
      mode: "key",
      provider: "anthropic",
    });
    expect(parseAuthCommand("/login anthropic browser")).toEqual({
      error: "anthropic subscription login is not supported — run /login anthropic key or set ANTHROPIC_API_KEY",
    });
    expect(parseAuthCommand("/login openai oauth")).toEqual({
      cmd: "login",
      mode: "browser",
      provider: "openai-codex",
    });
    expect(parseAuthCommand("/login openrouter browser")).toEqual({
      cmd: "login",
      mode: "browser",
      provider: "openrouter",
    });
    expect(parseAuthCommand("/login google browser")).toEqual({ error: "google has no browser login" });
    expect(parseAuthCommand("/login xai browser")).toEqual({ error: "xai has no browser login" });
  });
});
