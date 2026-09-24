/** Shared pricing/context catalog loading. Request routing and cost arithmetic stay with their owners. */
import { AUTH_PROVIDER_ORDER, type ProviderId, type ProviderProtocol } from "../auth.ts";
import { acceptedContextWindow } from "../models/capabilities.ts";
import { catalogProviderId, contextCatalogEntryKey, contextCatalogProviderId } from "../models.ts";
import { normalizeRateSnapshot, type RateSnapshot } from "../rates.ts";
import { readBoundedResponseBody } from "../tool-output.ts";
import { cacheRouteForProvider } from "./cache-capabilities.ts";

// Providers bill tokens; this adapter turns one complete catalog response into
// immutable, role/route/model-scoped snapshots. `rates.ts` owns validation and
// arithmetic so missing counters/rates remain unknown and cache-write prices
// never fall back to input pricing.
type CatalogCost = Record<string, unknown>;
type CatalogModelEntry = { cost?: CatalogCost; limit?: { context?: unknown } };
type CatalogProvider = { models?: Record<string, CatalogModelEntry>; version?: unknown; updatedAt?: unknown };
type CatalogResponse = Record<string, CatalogProvider> & { version?: unknown; updatedAt?: unknown };

const RATE_CATALOG_URL = "https://models.dev/api.json";
// Background budget only: run startup races this load with a short wait
// (awaitInitialRates), so a generous timeout never blocks the terminal.
// The catalog body is ~4.5MB and growing; first byte alone can take ~200ms.
const RATE_FETCH_TIMEOUT_MS = 30_000;
const RATE_CATALOG_BODY_CAP_BYTES = 16 * 1024 * 1024;
// A transient boot-network failure must not pin an empty map forever: retry
// a bounded number of times inside the background load, then let the next
// run re-kick it via ensureRatesLoading.
const RATE_LOAD_MAX_ATTEMPTS = 3;
const RATE_LOAD_RETRY_DELAY_MS = 2_000;
const RATE_UNITS = {
  input: "usd_per_million_tokens",
  cacheRead: "usd_per_million_tokens",
  cacheWrite: "usd_per_million_tokens",
  output: "usd_per_million_tokens",
  reasoning: "usd_per_million_tokens",
  storage: "usd_per_gib_second",
} as const;
export function catalogKey(provider: string, model: string, role: "main" | "summary"): string {
  return `${provider}\0${model}\0${role}`;
}

/** The context entry for a route's provider, or null when it has no models.
 *  Narrows `models` to a present record so callers need no second check. */
function contextCatalogEntry(
  db: CatalogResponse,
  provider: ProviderId,
): { models: Record<string, CatalogModelEntry> } | null {
  const entry = db[contextCatalogProviderId(provider)];
  if (!entry || typeof entry !== "object" || !entry.models || typeof entry.models !== "object") return null;
  return { models: entry.models };
}

function catalogMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() && value.length <= 256 ? value.trim() : null;
}

function rateFromCatalog(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function freezeRateSnapshot(snapshot: RateSnapshot): RateSnapshot {
  return Object.freeze({
    ...snapshot,
    scope: Object.freeze({ ...snapshot.scope }),
    units: Object.freeze({ ...snapshot.units }),
    rates: Object.freeze({ ...snapshot.rates }),
  });
}

function snapshotForCatalogEntry(
  provider: ProviderId,
  model: string,
  role: "main" | "summary",
  cost: CatalogCost,
  version: string | null,
  lookedUpAt: string,
  protocol: ProviderProtocol,
): RateSnapshot | null {
  return normalizeRateSnapshot({
    scope: {
      provider,
      protocol,
      model,
      route: cacheRouteForProvider(provider),
      role,
    },
    source: RATE_CATALOG_URL,
    version,
    lookedUpAt,
    units: RATE_UNITS,
    // A catalog entry does not document provider retention. The request's
    // effective cache policy supplies a per-attempt TTL class later.
    cacheWriteTtlClass: "unknown",
    reasoningBilling: rateFromCatalog(cost.reasoning) === null ? null : "separate",
    rates: {
      input: rateFromCatalog(cost.input),
      cacheRead: rateFromCatalog(cost.cache_read),
      cacheWrite: rateFromCatalog(cost.cache_write),
      output: rateFromCatalog(cost.output),
      reasoning: rateFromCatalog(cost.reasoning),
      storage: null,
    },
  });
}

/** One background load publishes both maps. A task can retain its original map.
 * Protocol resolution stays with the caller's live provider catalog. */
export function createRateCatalog(providerProtocol: (provider: ProviderId, model: string) => ProviderProtocol) {
  let rateSnapshotMap: ReadonlyMap<string, RateSnapshot> = new Map();
  let contextCatalogMap: ReadonlyMap<string, number> = new Map();
  let ratesLoadPromise: Promise<void> | null = null;

  async function loadRates(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RATE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(RATE_CATALOG_URL, { signal: controller.signal });
      if (!res.ok) return false;
      const body = await readBoundedResponseBody(res, { maxBytes: RATE_CATALOG_BODY_CAP_BYTES });
      if (body.state !== "complete" || body.truncated) return false;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.text) as unknown;
      } catch {
        return false;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const db = parsed as CatalogResponse;
      const lookedUpAt = new Date().toISOString();
      const version = catalogMetadata(db.version) ?? catalogMetadata(db.updatedAt);
      const next = new Map<string, RateSnapshot>();
      // Context is captured here rather than in a second fetch: this payload
      // already carries `limit.context` for every model of every provider, and
      // this loop already walks exactly the (provider, model) pairs we route to.
      const nextContext = new Map<string, number>();
      for (const providerId of AUTH_PROVIDER_ORDER) {
        // Context is gathered first and independently of pricing: it comes from a
        // different provider entry (Copilot is billed as OpenAI but serves its own
        // model list), and a catalog missing pricing must not hide its windows.
        const contextCatalog = contextCatalogEntry(db, providerId);
        if (contextCatalog) {
          for (const [model, entry] of Object.entries(contextCatalog.models)) {
            const context = Number(entry?.limit?.context);
            const window = acceptedContextWindow(context);
            if (window !== undefined) {
              nextContext.set(contextCatalogEntryKey(providerId, model), window);
            }
          }
        }
        const catalog = db[catalogProviderId(providerId)];
        if (!catalog || typeof catalog !== "object" || !catalog.models || typeof catalog.models !== "object") continue;
        for (const [model, entry] of Object.entries(catalog.models)) {
          if (!entry || typeof entry !== "object") continue;
          if (!entry.cost || typeof entry.cost !== "object") continue;
          for (const role of ["main", "summary"] as const) {
            const snapshot = snapshotForCatalogEntry(providerId, model, role, entry.cost, version, lookedUpAt, providerProtocol(providerId, model));
            if (snapshot) next.set(catalogKey(providerId, model, role), freezeRateSnapshot(snapshot));
          }
        }
      }
      // Replace the maps only after the response has been fully normalized. A
      // logical task keeps the previous map reference and cannot observe a
      // half-loaded or changing catalog.
      rateSnapshotMap = next;
      contextCatalogMap = nextContext;
      return true;
    } catch {
      /* Offline/catalog failure leaves the scoped snapshot unknown. */
      return false;
    } finally {
      clearTimeout(timer);
      // Release unread error bodies and failed reads as well as the deadline.
      controller.abort();
    }
  }

  async function loadRatesWithRetry(): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      if (await loadRates()) return true;
      if (attempt >= RATE_LOAD_MAX_ATTEMPTS) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, RATE_LOAD_RETRY_DELAY_MS * attempt));
    }
  }

  function ensureRatesLoading(): Promise<void> {
    if (!ratesLoadPromise) {
      ratesLoadPromise = loadRatesWithRetry().then(
        (ok) => {
          // A failed background load must not pin the failed state: the next
          // run retries instead of serving an empty map forever.
          if (!ok) ratesLoadPromise = null;
        },
        () => {
          ratesLoadPromise = null;
        },
      );
    }
    return ratesLoadPromise;
  }

  async function awaitInitialRates(timeoutMs = 250): Promise<void> {
    const pending = ensureRatesLoading();
    if (timeoutMs <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pending,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get rates() { return rateSnapshotMap; },
    get contexts() { return contextCatalogMap; },
    ensureLoading: ensureRatesLoading,
    awaitInitial: awaitInitialRates,
  };
}
