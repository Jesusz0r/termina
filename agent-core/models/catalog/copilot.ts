function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function copilotCatalogContext(row: Record<string, unknown>): unknown {
  const limits = asRecord(asRecord(row.capabilities)?.limits);
  return limits?.max_context_window_tokens ?? limits?.max_prompt_tokens;
}

export function copilotCatalogEndpoints(row: Record<string, unknown>): string[] | undefined {
  const advertised = row.supported_endpoints;
  return Array.isArray(advertised)
    ? ["/responses", "/chat/completions", "/v1/messages"].filter((endpoint) => advertised.includes(endpoint))
    : undefined;
}
