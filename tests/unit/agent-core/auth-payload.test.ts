import { describe, expect, it } from "vitest";
import { parseCopilotSession, parseDeviceCode, parseDeviceToken, parseOauthToken, parseStoredOauth } from "../../../agent-core/auth/oauth-payload.ts";
import { parseStoredCredential } from "../../../agent-core/auth/store.ts";

// Only synthetic values are used. Assertions never print token contents.
describe("auth payload parsers", () => {
  it.each([null, 42, "token", []])("rejects non-object token body %j", (value) => {
    expect(parseOauthToken(value)).toEqual({ ok: false, error: "invalid token response" });
  });

  it("rejects a stored entry whose type is not oauth", () => {
    expect(parseStoredOauth({ type: "api_key" })).toBeNull();
    expect(parseStoredOauth({ type: "other" })).toBeNull();
    expect(parseStoredCredential({ type: "other" })).toBeNull();
    expect(parseStoredCredential([])).toBeNull();
  });

  it("keeps exact stored metadata for refresh comparisons and types incomplete entries", () => {
    const raw = { type: "oauth", access: "fixture", refresh: "fixture", expires: 0, metadata: { label: "keep" } };
    const entry = parseStoredCredential(raw);
    expect(entry?.type).toBe("oauth");
    expect(entry?.extra === raw).toBe(true);
    expect(parseStoredOauth({ type: "oauth" })?.refresh).toBeNull();
  });

  it("preserves token expiry and refresh defaults", () => {
    const parsed = parseOauthToken({ access_token: "fixture", expires_in: "3600" }, 1000, {
      requireRefresh: false, previousRefresh: "fixture",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("fixture token must parse");
    expect(parsed.expires).toBe(3_301_000);
    expect(typeof parsed.refresh).toBe("string");
    expect(parseOauthToken({ access_token: "fixture" }).ok).toBe(false);
  });

  it("rejects non-object device, poll and Copilot bodies at their parser boundaries", () => {
    expect(parseDeviceCode([])).toBe("invalid");
    expect(parseDeviceCode({})).toBe("missing-fields");
    expect(parseDeviceToken([])).toBeNull();
    expect(parseCopilotSession([])).toBeNull();
    expect(parseCopilotSession({ token: [] })).toBeNull();
  });

  it("leaves omitted device timings unknown for the existing flow defaults", () => {
    const parsed = parseDeviceCode({ device_code: "fixture", user_code: "fixture", verification_uri: "https://github.com/login/device" });
    if (typeof parsed === "string") throw new Error("fixture device must parse");
    expect(Number.isNaN(parsed.interval)).toBe(true);
    expect(Number.isNaN(parsed.expiresIn)).toBe(true);
  });
});
