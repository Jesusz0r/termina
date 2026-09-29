import { describe, expect, it } from "vitest";
import { parseCopilotSession, parseDeviceCode, parseDeviceToken, parseOauthToken, parseStoredOauth } from "../../../agent-core/auth/oauth-payload.ts";
import { parseStoredCredential } from "../../../agent-core/auth/store.ts";

// Only synthetic values are used. Assertions never print token contents.
describe("auth payload parsers", () => {
  it.each([null, 42, "token", []].map((value) => ({ value })))("rejects non-object token body $value", ({ value }) => {
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

  it.each([true, [3600], {}, { toString: "malformed" }, "bad"].map((value) => ({ value })))("rejects malformed timing values $value inside the parser", ({ value }) => {
    const token = { access_token: "fixture", refresh_token: "fixture", expires_in: value };
    expect(parseOauthToken(token, 1000).ok).toBe(false);
    expect(parseOauthToken(token, 1000, { defaultExpiresIn: 3600 }).ok).toBe(false);
    const device = { device_code: "fixture", user_code: "fixture", verification_uri: "https://github.com/login/device" };
    expect(parseDeviceCode({ ...device, interval: value }) === "invalid").toBe(true);
    expect(parseDeviceCode({ ...device, expires_in: value }) === "invalid").toBe(true);
  });

  it("preserves omitted expiry defaults and numeric-string device timings", () => {
    const token = parseOauthToken({ access_token: "fixture", refresh_token: "fixture" }, 1000, { defaultExpiresIn: 3600 });
    expect(token.ok).toBe(true);
    if (!token.ok) throw new Error("fixture token must parse");
    expect(token.expires).toBe(3_301_000);
    const device = parseDeviceCode({ device_code: "fixture", user_code: "fixture", interval: "5", expires_in: "60" });
    if (typeof device === "string") throw new Error("fixture device must parse");
    expect(device.interval).toBe(5);
    expect(device.expiresIn).toBe(60);
  });

  it.each([1e308, "1e308"])("rejects token and device timing overflow %s", (expiresIn) => {
    expect(parseOauthToken({ access_token: "fixture", refresh_token: "fixture", expires_in: expiresIn }, 1000).ok).toBe(false);
    expect(parseOauthToken({ access_token: "fixture", refresh_token: "fixture" }, 1000, { defaultExpiresIn: 1e308 }).ok).toBe(false);
    const device = { device_code: "fixture", user_code: "fixture" };
    expect(parseDeviceCode({ ...device, interval: expiresIn }) === "invalid").toBe(true);
    expect(parseDeviceCode({ ...device, expires_in: expiresIn }) === "invalid").toBe(true);
  });

  it("rejects Copilot expiry overflow and owns the existing deadline calculation", () => {
    expect(parseCopilotSession({ token: "fixture", refresh_in: 1e308 }, 1000) === null).toBe(true);
    const cases = [
      { fields: { expires_at: 3600 }, expected: 3_300_000 },
      { fields: { expires_at: 1_700_000_000_000 }, expected: 1_699_999_700_000 },
      { fields: { refresh_in: 3600 }, expected: 3_301_000 },
      { fields: {}, expected: 1_501_000 },
    ];
    for (const { fields, expected } of cases) {
      const parsed = parseCopilotSession({ token: "fixture", ...fields }, 1000);
      expect(parsed !== null).toBe(true);
      if (parsed === null) throw new Error("fixture session must parse");
      expect(parsed.expires).toBe(expected);
    }
  });

  it("leaves omitted device timings unknown for the existing flow defaults", () => {
    const parsed = parseDeviceCode({ device_code: "fixture", user_code: "fixture", verification_uri: "https://github.com/login/device" });
    if (typeof parsed === "string") throw new Error("fixture device must parse");
    expect(Number.isNaN(parsed.interval)).toBe(true);
    expect(Number.isNaN(parsed.expiresIn)).toBe(true);
  });
});
