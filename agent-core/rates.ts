/**
 * Deterministic price provenance for trace/cost accounting.
 *
 * Rates are supplied by the caller and are explicitly unit-bearing. This
 * module deliberately has no catalog loader or network dependency. A valid
 * snapshot describes one provider/protocol/model/route/role scope and one
 * cache-write/reasoning billing policy.
 */

export const RATE_FIELDS = [
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
  "storage",
] as const;

export const TOKEN_RATE_FIELDS = [
  "input",
  "cacheRead",
  "cacheWrite",
  "output",
  "reasoning",
] as const;

export const CACHE_WRITE_TTL_CLASSES = [
  "unknown",
  "provider-default",
  "5m",
  "30m",
  "1h",
  "custom",
] as const;

export const REASONING_BILLING_RELATIONS = [
  "separate",
  "included-in-output",
] as const;

export const TOKEN_RATE_UNITS = [
  "usd_per_token",
  "usd_per_million_tokens",
] as const;

export const STORAGE_RATE_UNITS = [
  "usd_per_byte",
  "usd_per_gib",
  "usd_per_byte_second",
  "usd_per_gib_second",
] as const;

export type RateField = (typeof RATE_FIELDS)[number];
export type TokenRateField = (typeof TOKEN_RATE_FIELDS)[number];
export type CacheWriteTtlClass = (typeof CACHE_WRITE_TTL_CLASSES)[number];
export type ReasoningBillingRelation = (typeof REASONING_BILLING_RELATIONS)[number];
export type TokenRateUnit = (typeof TOKEN_RATE_UNITS)[number];
export type StorageRateUnit = (typeof STORAGE_RATE_UNITS)[number];
export type CostRole = "main" | "summary";

export interface RateScope {
  readonly provider: string;
  readonly protocol: string;
  readonly model: string;
  readonly route: string;
  readonly role: CostRole;
}

export type CostScope = Omit<RateScope, "role">;

export interface StorageUsage {
  /** Quantity in the unit named by `unit`; duration is required for *_second rates. */
  readonly quantity: number | null;
  readonly unit: "byte" | "gib";
  readonly durationSeconds: number | null;
}

export interface RateCard {
  readonly input: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly storage: number | null;
}

export interface RateUnits {
  readonly input: TokenRateUnit;
  readonly cacheRead: TokenRateUnit;
  readonly cacheWrite: TokenRateUnit;
  readonly output: TokenRateUnit;
  readonly reasoning: TokenRateUnit;
  readonly storage: StorageRateUnit;
}

export interface RateSnapshot {
  readonly scope: RateScope;
  readonly source: string | null;
  readonly version: string | null;
  readonly lookedUpAt: string | null;
  readonly units: RateUnits;
  readonly cacheWriteTtlClass: CacheWriteTtlClass | null;
  readonly reasoningBilling: ReasoningBillingRelation | null;
  readonly rates: RateCard;
}

export type RateSnapshotInput = {
  readonly scope?: unknown;
  readonly source?: unknown;
  readonly version?: unknown;
  readonly lookedUpAt?: unknown;
  readonly units?: unknown;
  readonly cacheWriteTtlClass?: unknown;
  readonly reasoningBilling?: unknown;
  readonly rates?: unknown;
};

export type RateSnapshotValidation =
  | {
      readonly ok: true;
      readonly value: RateSnapshot;
      readonly errors: readonly [];
    }
  | {
      readonly ok: false;
      readonly value: null;
      readonly errors: readonly string[];
    };

export interface RateUsage {
  readonly input?: number | null;
  readonly cacheRead?: number | null;
  readonly cacheWrite?: number | null;
  readonly output?: number | null;
  readonly reasoning?: number | null;
  readonly storage?: StorageUsage | null;
}

export interface TraceCostInput {
  readonly role: CostRole;
  readonly scope: CostScope;
  readonly usage: RateUsage | null | undefined;
  readonly snapshot: RateSnapshot | null | undefined;
  /** Fields actually billed by the selected route. */
  readonly requiredFields?: readonly RateField[];
}

export type TraceUnknownField =
  | RateField
  | "source"
  | "version"
  | "lookedUpAt"
  | "scope"
  | "units"
  | "cacheWriteTtlClass"
  | "reasoningBilling"
  | "aggregate";

export interface TraceCostResult {
  readonly role: CostRole;
  readonly scope: RateScope | null;
  readonly scopeMatch: boolean;
  readonly usd: number | null;
  readonly source: string | null;
  readonly version: string | null;
  readonly lookedUpAt: string | null;
  readonly units: RateUnits | null;
  readonly cacheWriteTtlClass: CacheWriteTtlClass | null;
  readonly reasoningBilling: ReasoningBillingRelation | null;
  /** Fields for which both the counter and rate were complete and finite. */
  readonly knownFields: readonly RateField[];
  /** Missing/invalid counters, rates, provenance, policy, scope, or overflow. */
  readonly unknownFields: readonly TraceUnknownField[];
  readonly components: Readonly<Record<RateField, number | null>>;
}

type RecordLike = Record<string, unknown>;

const MAX_METADATA_CHARS = 256;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const UNKNOWN_FIELD_ORDER: readonly TraceUnknownField[] = [
  ...RATE_FIELDS,
  "source",
  "version",
  "lookedUpAt",
  "scope",
  "units",
  "cacheWriteTtlClass",
  "reasoningBilling",
  "aggregate",
];

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  errors: string[],
): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    errors.push(field);
    return null;
  }
  return value as T;
}

function requiredEnumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  errors: string[],
): T | null {
  if (value === undefined || value === null) {
    errors.push(field);
    return null;
  }
  return enumValue(value, allowed, field, errors);
}

function nullableMetadata(
  value: unknown,
  field: "source" | "version" | "lookedUpAt",
  errors: string[],
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    errors.push(field);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_METADATA_CHARS || CONTROL_CHARS.test(trimmed)) {
    errors.push(field);
    return null;
  }
  if (field === "lookedUpAt" && !Number.isFinite(Date.parse(trimmed))) {
    errors.push(field);
    return null;
  }
  return trimmed;
}

function requiredScopeText(value: unknown, field: string, errors: string[]): string | null {
  if (typeof value !== "string") {
    errors.push(field);
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_METADATA_CHARS || CONTROL_CHARS.test(trimmed)) {
    errors.push(field);
    return null;
  }
  return trimmed;
}

function scopeValue(value: unknown, errors: string[], field = "scope"): RateScope | null {
  if (!isRecord(value)) {
    errors.push(field);
    return null;
  }
  const provider = requiredScopeText(value.provider, `${field}.provider`, errors);
  const protocol = requiredScopeText(value.protocol, `${field}.protocol`, errors);
  const model = requiredScopeText(value.model, `${field}.model`, errors);
  const route = requiredScopeText(value.route, `${field}.route`, errors);
  const role = requiredEnumValue(value.role, ["main", "summary"] as const, `${field}.role`, errors);
  if (provider === null || protocol === null || model === null || route === null || role === null) return null;
  return { provider, protocol, model, route, role };
}

function nullableRate(value: unknown, field: RateField, errors: string[]): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    errors.push(`rates.${field}`);
    return null;
  }
  return value;
}

function unitsValue(value: unknown, errors: string[]): RateUnits | null {
  if (!isRecord(value)) {
    errors.push("units");
    return null;
  }
  const input = requiredEnumValue(value.input, TOKEN_RATE_UNITS, "units.input", errors);
  const cacheRead = requiredEnumValue(value.cacheRead, TOKEN_RATE_UNITS, "units.cacheRead", errors);
  const cacheWrite = requiredEnumValue(value.cacheWrite, TOKEN_RATE_UNITS, "units.cacheWrite", errors);
  const output = requiredEnumValue(value.output, TOKEN_RATE_UNITS, "units.output", errors);
  const reasoning = requiredEnumValue(value.reasoning, TOKEN_RATE_UNITS, "units.reasoning", errors);
  const storage = requiredEnumValue(value.storage, STORAGE_RATE_UNITS, "units.storage", errors);
  if (input === null || cacheRead === null || cacheWrite === null || output === null || reasoning === null || storage === null) return null;
  return { input, cacheRead, cacheWrite, output, reasoning, storage };
}

/**
 * Validate and normalize a caller-supplied rate snapshot. Missing rate values
 * become null (unknown); malformed values are rejected rather than coerced.
 * Missing provenance/policy values remain nullable so the caller can record an
 * incomplete snapshot, but such a snapshot cannot produce a known cost.
 */
export function validateRateSnapshot(value: unknown): RateSnapshotValidation {
  if (!isRecord(value)) return { ok: false, value: null, errors: ["snapshot"] };

  const errors: string[] = [];
  const scope = scopeValue(value.scope, errors);
  const source = nullableMetadata(value.source, "source", errors);
  const version = nullableMetadata(value.version, "version", errors);
  const lookedUpAt = nullableMetadata(value.lookedUpAt, "lookedUpAt", errors);
  const units = unitsValue(value.units, errors);
  const cacheWriteTtlClass = enumValue(
    value.cacheWriteTtlClass,
    CACHE_WRITE_TTL_CLASSES,
    "cacheWriteTtlClass",
    errors,
  );
  const reasoningBilling = enumValue(
    value.reasoningBilling,
    REASONING_BILLING_RELATIONS,
    "reasoningBilling",
    errors,
  );

  let ratesValue: unknown = value.rates;
  if (ratesValue === undefined) ratesValue = value;
  if (!isRecord(ratesValue)) {
    errors.push("rates");
    ratesValue = {};
  }
  const rateObject = ratesValue as RecordLike;
  const rates = {
    input: nullableRate(rateObject.input, "input", errors),
    cacheRead: nullableRate(rateObject.cacheRead, "cacheRead", errors),
    cacheWrite: nullableRate(rateObject.cacheWrite, "cacheWrite", errors),
    output: nullableRate(rateObject.output, "output", errors),
    reasoning: nullableRate(rateObject.reasoning, "reasoning", errors),
    storage: nullableRate(rateObject.storage, "storage", errors),
  } satisfies RateCard;

  if (errors.length > 0 || scope === null || units === null) return { ok: false, value: null, errors };
  return {
    ok: true,
    value: {
      scope,
      source,
      version,
      lookedUpAt,
      units,
      cacheWriteTtlClass,
      reasoningBilling,
      rates,
    },
    errors: [],
  };
}

/** Return null for malformed input while preserving valid-but-unknown rates. */
export function normalizeRateSnapshot(value: unknown): RateSnapshot | null {
  const result = validateRateSnapshot(value);
  return result.ok ? result.value : null;
}

function canonicalFields(fields: readonly RateField[]): RateField[] {
  const wanted = new Set<RateField>();
  for (const field of fields) {
    if ((RATE_FIELDS as readonly string[]).includes(field)) wanted.add(field);
  }
  return RATE_FIELDS.filter((field) => wanted.has(field));
}

function canonicalUnknownFields(fields: readonly TraceUnknownField[]): TraceUnknownField[] {
  const wanted = new Set<TraceUnknownField>();
  for (const field of fields) {
    if ((UNKNOWN_FIELD_ORDER as readonly string[]).includes(field)) wanted.add(field as TraceUnknownField);
  }
  return UNKNOWN_FIELD_ORDER.filter((field) => wanted.has(field));
}

function expectedScope(input: TraceCostInput): RateScope | null {
  const errors: string[] = [];
  const scope = scopeValue({ ...input.scope, role: input.role }, errors, "scope");
  return scope !== null && errors.length === 0 ? scope : null;
}

function scopesEqual(left: RateScope | null, right: RateScope | null): boolean {
  return left !== null && right !== null && left.provider === right.provider && left.protocol === right.protocol && left.model === right.model && left.route === right.route && left.role === right.role;
}

function requiredFieldsFor(input: TraceCostInput, reasoningBilling: ReasoningBillingRelation | null): RateField[] {
  let required = input.requiredFields
    ? canonicalFields(input.requiredFields)
    : [...TOKEN_RATE_FIELDS];
  if (reasoningBilling === "included-in-output") {
    required = required.filter((field) => field !== "reasoning");
  }
  if (!input.requiredFields && isRecord(input.usage) && hasOwn(input.usage, "storage")) required.push("storage");
  return canonicalFields(required);
}

function tokenQuantity(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function tokenComponent(value: unknown, rate: number | null, unit: TokenRateUnit | null): number | null {
  const quantity = tokenQuantity(value);
  if (quantity === null || rate === null || unit === null) return null;
  const normalizedQuantity = unit === "usd_per_million_tokens" ? quantity / 1_000_000 : quantity;
  const result = normalizedQuantity * rate;
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function storageComponent(value: unknown, rate: number | null, unit: StorageRateUnit | null): number | null {
  if (!isRecord(value) || rate === null || unit === null) return null;
  const quantity = tokenQuantity(value.quantity);
  const storageUnit = value.unit;
  const rawDuration = value.durationSeconds;
  const duration = rawDuration === null || rawDuration === undefined ? null : tokenQuantity(rawDuration);
  if (quantity === null || (storageUnit !== "byte" && storageUnit !== "gib")) return null;
  if (rawDuration !== null && rawDuration !== undefined && duration === null) return null;

  const temporal = unit.endsWith("_second");
  const expectedUnit = unit.startsWith("usd_per_byte") ? "byte" : "gib";
  if (storageUnit !== expectedUnit || (temporal && duration === null)) return null;
  const billableQuantity = temporal ? quantity * (duration as number) : quantity;
  const result = billableQuantity * rate;
  return Number.isFinite(billableQuantity) && Number.isFinite(result) && result >= 0 ? result : null;
}

function addUnknown(fields: Set<TraceUnknownField>, field: TraceUnknownField): void {
  fields.add(field);
}

/**
 * Compute a cost only when every selected billed field has a known counter and
 * rate, the snapshot matches the complete route scope, provenance is present,
 * and the billing policy is explicit. Missing cache-write pricing never falls
 * back to input pricing. Reasoning is either a separate component or omitted
 * when the provider includes it in output, preventing double counting.
 */
export function computeTraceCost(input: TraceCostInput): TraceCostResult {
  if (input.role !== "main" && input.role !== "summary") throw new TypeError("role must be main or summary");

  const requestedScope = expectedScope(input);
  const rawSnapshot = normalizeRateSnapshot(input.snapshot);
  const scopeMatch = scopesEqual(rawSnapshot?.scope ?? null, requestedScope);
  const snapshot = scopeMatch ? rawSnapshot : null;
  const usage = isRecord(input.usage) ? input.usage : null;
  const reasoningBilling = rawSnapshot?.reasoningBilling ?? null;
  const required = requiredFieldsFor(input, reasoningBilling);
  const requiredSet = new Set(required);
  const knownFields: RateField[] = [];
  const unknown = new Set<TraceUnknownField>();
  const components: Record<RateField, number | null> = {
    input: null,
    cacheRead: null,
    cacheWrite: null,
    output: null,
    reasoning: null,
    storage: null,
  };

  if (!scopeMatch) addUnknown(unknown, "scope");
  if (rawSnapshot === null) {
    addUnknown(unknown, "source");
    addUnknown(unknown, "version");
    addUnknown(unknown, "lookedUpAt");
    addUnknown(unknown, "units");
  } else {
    if (rawSnapshot.source === null) addUnknown(unknown, "source");
    if (rawSnapshot.version === null) addUnknown(unknown, "version");
    if (rawSnapshot.lookedUpAt === null) addUnknown(unknown, "lookedUpAt");
  }
  if (reasoningBilling === null && requiredSet.has("reasoning")) addUnknown(unknown, "reasoningBilling");
  const cacheWriteQuantity = tokenQuantity(usage?.cacheWrite);
  if (requiredSet.has("cacheWrite") && cacheWriteQuantity !== 0 && (rawSnapshot === null || rawSnapshot.cacheWriteTtlClass === null || rawSnapshot.cacheWriteTtlClass === "unknown")) {
    addUnknown(unknown, "cacheWriteTtlClass");
  }

  for (const field of RATE_FIELDS) {
    if (!requiredSet.has(field)) continue;
    const rate = snapshot?.rates[field] ?? null;
    const priced = field === "storage"
      ? storageComponent(usage?.storage, rate, snapshot?.units.storage ?? null)
      : tokenComponent(usage?.[field], rate, snapshot?.units[field] as TokenRateUnit | null ?? null);
    components[field] = priced;
    if (priced === null) addUnknown(unknown, field);
    else knownFields.push(field);
  }

  const unknownFields = canonicalUnknownFields([...unknown]);
  let usd: number | null = null;
  if (unknownFields.length === 0) {
    const aggregate = required.reduce((sum, field) => sum + (components[field] ?? 0), 0);
    if (Number.isFinite(aggregate) && aggregate >= 0) usd = aggregate;
    else unknownFields.push("aggregate");
  }

  return {
    role: input.role,
    scope: rawSnapshot?.scope ?? requestedScope,
    scopeMatch,
    usd,
    source: rawSnapshot?.source ?? null,
    version: rawSnapshot?.version ?? null,
    lookedUpAt: rawSnapshot?.lookedUpAt ?? null,
    units: rawSnapshot?.units ?? null,
    cacheWriteTtlClass: rawSnapshot?.cacheWriteTtlClass ?? null,
    reasoningBilling,
    knownFields,
    unknownFields,
    components,
  };
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Serialize a normalized snapshot with fixed key and field order. */
export function serializeRateSnapshot(snapshot: RateSnapshot): string {
  const checked = validateRateSnapshot(snapshot);
  if (!checked.ok) throw new TypeError(`invalid rate snapshot: ${checked.errors.join(",")}`);
  const value = checked.value;
  return JSON.stringify({
    scope: {
      provider: value.scope.provider,
      protocol: value.scope.protocol,
      model: value.scope.model,
      route: value.scope.route,
      role: value.scope.role,
    },
    source: value.source,
    version: value.version,
    lookedUpAt: value.lookedUpAt,
    units: {
      input: value.units.input,
      cacheRead: value.units.cacheRead,
      cacheWrite: value.units.cacheWrite,
      output: value.units.output,
      reasoning: value.units.reasoning,
      storage: value.units.storage,
    },
    cacheWriteTtlClass: value.cacheWriteTtlClass,
    reasoningBilling: value.reasoningBilling,
    rates: {
      input: value.rates.input,
      cacheRead: value.rates.cacheRead,
      cacheWrite: value.rates.cacheWrite,
      output: value.rates.output,
      reasoning: value.rates.reasoning,
      storage: value.rates.storage,
    },
  });
}

/** Serialize cost/provenance with fixed ordering, independent of input order. */
export function serializeTraceCost(cost: TraceCostResult): string {
  if (cost.role !== "main" && cost.role !== "summary") throw new TypeError("invalid cost role");
  const usd = finiteNonNegative(cost.usd);
  if (cost.usd !== null && usd === null) throw new TypeError("invalid cost usd");
  const components: Record<RateField, number | null> = {
    input: finiteNonNegative(cost.components.input),
    cacheRead: finiteNonNegative(cost.components.cacheRead),
    cacheWrite: finiteNonNegative(cost.components.cacheWrite),
    output: finiteNonNegative(cost.components.output),
    reasoning: finiteNonNegative(cost.components.reasoning),
    storage: finiteNonNegative(cost.components.storage),
  };
  const scope = cost.scope
    ? {
        provider: cost.scope.provider,
        protocol: cost.scope.protocol,
        model: cost.scope.model,
        route: cost.scope.route,
        role: cost.scope.role,
      }
    : null;
  const units = cost.units
    ? {
        input: cost.units.input,
        cacheRead: cost.units.cacheRead,
        cacheWrite: cost.units.cacheWrite,
        output: cost.units.output,
        reasoning: cost.units.reasoning,
        storage: cost.units.storage,
      }
    : null;
  return JSON.stringify({
    role: cost.role,
    scope,
    scopeMatch: cost.scopeMatch,
    usd,
    source: cost.source ?? null,
    version: cost.version ?? null,
    lookedUpAt: cost.lookedUpAt ?? null,
    units,
    cacheWriteTtlClass: cost.cacheWriteTtlClass ?? null,
    reasoningBilling: cost.reasoningBilling ?? null,
    knownFields: canonicalFields(cost.knownFields),
    unknownFields: canonicalUnknownFields(cost.unknownFields),
    components,
  });
}
