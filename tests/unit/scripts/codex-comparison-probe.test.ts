import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({ resolveAuth: vi.fn(), authPath: vi.fn(), homedir: vi.fn() }));
vi.mock("../../../agent-core/auth.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../agent-core/auth.ts")>(),
  resolveAuth: mocks.resolveAuth, authPath: mocks.authPath,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(), homedir: mocks.homedir,
}));

let home: string;
const SECRET = "fixture-sensitive-payload-do-not-print";
function completed(id: string, diagnostics?: object, usage?: object) {
  return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
    id, status: "completed", output: [],
    usage: usage ?? { input_tokens: 3000, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    ...(diagnostics ? { prompt_cache_diagnostics: diagnostics } : {}),
  } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const output = () => vi.mocked(console.log).mock.calls.flat().join("\n");
async function run(args = ["--live"]) {
  const { runComparisonProbe } = await import("../../../scripts/codex-comparison-probe.ts");
  return runComparisonProbe(args);
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  home = realpathSync(mkdtempSync(join(tmpdir(), "termina-comparison-test-")));
  mocks.homedir.mockReturnValue(home);
  mocks.authPath.mockReturnValue(join(home, "auth.json"));
  mocks.resolveAuth.mockResolvedValue({ ok: true, baseUrl: "https://chatgpt.com/backend-api/codex", headers: { authorization: `Bearer ${SECRET}` } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("bounded Codex diagnostic comparison", () => {
  it("does nothing when imported and requires --live before credential or network access", async () => {
    await import("../../../scripts/codex-comparison-probe.ts");
    expect(console.log).not.toHaveBeenCalled();
    expect(await run([])).toBe(0);
    expect(mocks.authPath).not.toHaveBeenCalled();
    expect(mocks.resolveAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(output()).toContain("pass --live");
  });

  it("replays the same request, adding only the comparison id, with deadlines and no inferred policy", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(completed("baseline")).mockResolvedValueOnce(completed("comparison"));
    vi.stubGlobal("fetch", fetch);
    expect(await run()).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetch.mock.calls[0]![1].body);
    const second = JSON.parse(fetch.mock.calls[1]![1].body);
    expect(first.store).toBe(false);
    expect(second.prompt_cache_options).toEqual({ comparison_response_id: "baseline" });
    delete second.prompt_cache_options;
    expect(second).toEqual(first);
    expect(mocks.resolveAuth.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.redirect).toBe("error");
    }
    expect(output()).toContain("inconclusive; no backend policy inferred");
  });

  it("reports a diagnostic hit without calling it a miss or printing response identities", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(completed(SECRET)).mockResolvedValueOnce(completed(SECRET, { type: "cache_hit" }));
    vi.stubGlobal("fetch", fetch);
    expect(await run()).toBe(0);
    expect(output()).toContain("backend comparison=cache_hit");
    expect(output()).not.toContain(SECRET);
  });

  it("allowlists diagnostic enums and numeric usage instead of dumping provider payloads", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(completed(SECRET)).mockResolvedValueOnce(completed(SECRET,
      { type: "cache_miss", reason: "tools_changed", comparison_reusable_tokens: 3000, cache_missed_tokens: 2000, extra: SECRET },
      { input_tokens: 3000, output_tokens: 1, extra: SECRET },
    ));
    vi.stubGlobal("fetch", fetch);
    expect(await run()).toBe(0);
    expect(output()).toContain('"cache_missed_tokens":2000');
    expect(output()).toContain("backend comparison=cache_miss, reason=tools_changed");
    expect(output()).not.toContain(SECRET);
  });

  it("does not echo unknown diagnostic strings or malformed counts", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(completed(SECRET)).mockResolvedValueOnce(completed(SECRET,
      { type: SECRET, reason: SECRET, cache_missed_tokens: SECRET },
      { input_tokens: SECRET, output_tokens: SECRET },
    ));
    vi.stubGlobal("fetch", fetch);
    expect(await run()).toBe(0);
    expect(output()).toContain("backend comparison=unknown");
    expect(output()).not.toContain(SECRET);
  });

  it("does not retry an unsupported diagnostic request or echo its error body", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(completed("baseline")).mockResolvedValueOnce(new Response(`Unsupported prompt_cache_options: ${SECRET}`, { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    expect(await run()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(output()).toContain("comparison failed status=400");
    expect(output()).toContain("cache behavior remains inconclusive");
    expect(output()).not.toContain(SECRET);
  });

  it("stops after an incomplete baseline stream", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("data: [DONE]\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await run()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops if the baseline has no response identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(completed("")));
    expect(await run()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts credential resolution and transport failures", async () => {
    mocks.resolveAuth.mockResolvedValueOnce({ ok: false, error: SECRET });
    expect(await run()).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(output()).not.toContain(SECRET);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error(SECRET)));
    expect(await run()).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(output()).not.toContain(SECRET);
  });

  it.each(["http://chatgpt.com/backend-api/codex", "https://elsewhere.invalid", "https://chatgpt.com/backend-api/codex?secret=x"])("refuses a noncanonical route before inference: %s", async (baseUrl) => {
    mocks.resolveAuth.mockResolvedValueOnce({ ok: true, baseUrl, headers: { authorization: SECRET } });
    expect(await run()).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(output()).not.toContain(SECRET);
    expect(output()).not.toContain(baseUrl);
  });

  it.each([false, true])("refuses a foreign credential tree before resolving auth (symlink=%s)", async (symlink) => {
    // A synthetic HOME only; never inspect the host credential tree.
    const target = join(home, ".pi", "agent", "auth.json");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(target, "{}");
    const path = symlink ? join(home, "linked-auth.json") : target;
    if (symlink) symlinkSync(target, path);
    mocks.authPath.mockReturnValue(path);
    expect(await run()).toBe(1);
    expect(mocks.resolveAuth).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
