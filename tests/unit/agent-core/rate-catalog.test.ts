import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogKey, createRateCatalog } from "../../../agent-core/main/rate-catalog.ts";
import { contextCatalogEntryKey } from "../../../agent-core/models.ts";

const payload = {
  version: "fixture-1",
  openai: { models: {
    "fixture-model": { cost: { input: 2, output: 4, cache_read: 0.5 }, limit: { context: 100000 } },
    "unpriced-model": { limit: { context: 64000 } },
  } },
  "github-copilot": { models: { "fixture-model": { limit: { context: 128000 } } } },
  opencode: { models: { "fixture-model": { limit: { context: 256000 } } } },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shared rate/context catalog lifecycle", () => {
  it("joins one load, publishes both maps, and preserves captured maps", async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const protocol = vi.fn(() => "openai-responses" as const);
    const catalog = createRateCatalog(protocol);
    const initialRates = catalog.rates;
    const initialContexts = catalog.contexts;
    const first = catalog.ensureLoading();
    expect(catalog.ensureLoading()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(catalog.rates.size).toBe(0);
    expect(catalog.contexts.size).toBe(0);
    release(Response.json(payload));
    await first;
    expect(initialRates.size).toBe(0);
    expect(initialContexts.size).toBe(0);
    expect(catalog.rates).not.toBe(initialRates);
    expect(catalog.contexts).not.toBe(initialContexts);
    const main = catalog.rates.get(catalogKey("openai", "fixture-model", "main"))!;
    const summary = catalog.rates.get(catalogKey("openai", "fixture-model", "summary"))!;
    expect(main.scope).toMatchObject({ provider: "openai", model: "fixture-model", role: "main", protocol: "openai-responses" });
    expect(summary.scope.role).toBe("summary");
    expect(main.version).toBe("fixture-1");
    expect(main.rates).toMatchObject({ input: 2, output: 4, cacheRead: 0.5, cacheWrite: null });
    expect(main.cacheWriteTtlClass).toBe("unknown");
    expect(Object.isFrozen(main)).toBe(true);
    expect(Object.isFrozen(main.rates)).toBe(true);
    expect(Object.isFrozen(main.scope)).toBe(true);
    expect(Object.isFrozen(main.units)).toBe(true);
    expect(catalog.contexts.get(contextCatalogEntryKey("openai", "unpriced-model"))).toBe(64000);
    expect(catalog.rates.has(catalogKey("openai", "unpriced-model", "main"))).toBe(false);
    expect(catalog.contexts.get(contextCatalogEntryKey("github-copilot", "fixture-model"))).toBe(128000);
    expect(catalog.rates.get(catalogKey("github-copilot", "fixture-model", "main"))?.rates.input).toBe(2);
    expect(catalog.contexts.get(contextCatalogEntryKey("opencode-zen", "fixture-model"))).toBe(256000);
    expect(catalog.contexts.get(contextCatalogEntryKey("opencode-go", "fixture-model"))).toBe(256000);
    expect(protocol).toHaveBeenCalledWith("github-copilot", "fixture-model");
    await catalog.ensureLoading();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries malformed responses before atomically publishing a valid response", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("not json"))
      .mockResolvedValueOnce(Response.json(payload));
    vi.stubGlobal("fetch", fetch);
    const catalog = createRateCatalog(() => "openai-responses");
    const pending = catalog.ensureLoading();
    await vi.advanceTimersByTimeAsync(1999);
    expect(catalog.rates.size).toBe(0);
    expect(catalog.contexts.size).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(catalog.rates.size).toBeGreaterThan(0);
    expect(catalog.contexts.size).toBeGreaterThan(0);
  });

  it("limits retries and lets the next run retry a failed load", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    const catalog = createRateCatalog(() => "openai-responses");
    const pending = catalog.ensureLoading();
    await vi.runAllTimersAsync();
    await pending;
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(catalog.rates.size).toBe(0);
    expect(catalog.contexts.size).toBe(0);
    fetch.mockResolvedValue(Response.json(payload));
    await catalog.ensureLoading();
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(catalog.rates.size).toBeGreaterThan(0);
  });

  it("bounds startup waiting without cancelling the shared load", async () => {
    vi.useFakeTimers();
    let release!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const catalog = createRateCatalog(() => "openai-responses");
    let ready = false;
    const startup = catalog.awaitInitial().then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(249);
    expect(ready).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await startup;
    expect(catalog.rates.size).toBe(0);
    release(Response.json(payload));
    await catalog.ensureLoading();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(catalog.rates.size).toBeGreaterThan(0);
  });

  it("releases the startup timer after a fast load", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    const catalog = createRateCatalog(() => "openai-responses");
    await catalog.awaitInitial();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts rejected HTTP responses before retrying", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      signals.push(init.signal as AbortSignal);
      return new Response("service unavailable", { status: 503 });
    }));
    const catalog = createRateCatalog(() => "openai-responses");
    const pending = catalog.ensureLoading();
    await vi.runAllTimersAsync();
    await pending;
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts each stalled request at the existing deadline", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    const catalog = createRateCatalog(() => "openai-responses");
    const pending = catalog.ensureLoading();
    await vi.advanceTimersByTimeAsync(29999);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted).toBe(true);
    await vi.runAllTimersAsync();
    await pending;
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(catalog.rates.size).toBe(0);
  });

  it("does not publish partially normalized maps when protocol resolution fails", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    const catalog = createRateCatalog(() => { throw new Error("unavailable protocol"); });
    const originalRates = catalog.rates;
    const originalContexts = catalog.contexts;
    const pending = catalog.ensureLoading();
    await vi.runAllTimersAsync();
    await pending;
    expect(catalog.rates).toBe(originalRates);
    expect(catalog.contexts).toBe(originalContexts);
  });
});
