/** Parsed fields used by provider catalog policies. Raw JSON stays in models.ts. */
export type CatalogRow = {
  visibility?: string;
  copilotContext?: number;
  supportedEndpoints?: string[];
};

export type CatalogPolicy = {
  acceptsId: (lowercaseId: string) => boolean;
  acceptsRow?: (row: CatalogRow) => boolean;
  contextFallback?: (row: CatalogRow) => number | undefined;
  supportedEndpoints?: (row: CatalogRow) => string[] | undefined;
};
