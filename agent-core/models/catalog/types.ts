/** Provider differences consumed by the canonical catalog parser. */
export type CatalogPolicy = {
  acceptsId: (lowercaseId: string) => boolean;
  acceptsRow?: (row: Record<string, unknown>) => boolean;
  contextFallback?: (row: Record<string, unknown>) => unknown;
  supportedEndpoints?: (row: Record<string, unknown>) => string[] | undefined;
};
