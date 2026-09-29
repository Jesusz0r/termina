import type { CatalogRow } from "./types.ts";

export function copilotCatalogContext(row: CatalogRow): number | undefined {
  return row.copilotContext;
}

export function copilotCatalogEndpoints(row: CatalogRow): string[] | undefined {
  const advertised = row.supportedEndpoints;
  return advertised
    ? ["/responses", "/chat/completions", "/v1/messages"].filter((endpoint) => advertised.includes(endpoint))
    : undefined;
}
