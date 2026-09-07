/**
 * Bounds and marker names for the worldline owner (`electron/worldlines/`).
 * Recovery evidence is never auto-deleted; these bound admission and work.
 */
export const RUNTIME_ALLOWLIST = ["node_modules", ".venv", "venv"];
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 20 * 1024 * 1024;
export const MAX_TEMPLATE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_CANDIDATE_BYTES = 1024 * 1024 * 1024;
export const READY_TIMEOUT_MS = 90000;
/** Bound candidate cleanup when a startup hook ignores cancellation. */
export const CANDIDATE_CLEANUP_TIMEOUT_MS = 2500;
export const MAX_PI_RESOURCE_BYTES = 200 * 1024 * 1024;
export const MAX_WORLDLINE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_RUNS_PER_TERMINAL = 20;
export const MAX_RETAINED_RUNS = 200;
export const MAX_IGNORED_FILES = 5000;
export const MAX_IGNORED_BYTES = 200 * 1024 * 1024;
/** Retained promotion evidence is never auto-deleted; admission is bounded. */
export const MAX_PROMOTION_JOURNALS = 32;
export const MAX_PROMOTION_JOURNAL_BYTES = 8 * 1024 * 1024 * 1024;
export const MAX_PROMOTION_JOURNAL_OVERHEAD_BYTES = 32 * 1024 * 1024;
export const MAX_PROMOTION_OPERATION_BYTES = MAX_TEMPLATE_BYTES * 2 + MAX_SESSION_BYTES + MAX_PROMOTION_JOURNAL_OVERHEAD_BYTES;
export const MAX_PROMOTION_JOURNAL_ROOT_ENTRIES = MAX_PROMOTION_JOURNALS * 4;
/** Durable, root-scoped admission state for promotion journals. */
export const PROMOTION_JOURNAL_USAGE_LEDGER = ".termina-promotion-journal-usage.json";
export const PROMOTION_JOURNAL_USAGE_LEDGER_VERSION = 1;
/** Uncertain comparisons are recovery evidence; never auto-delete at this bound. */
export const MAX_UNCERTAIN_COMPARISONS = 128;
export const MAX_UNCERTAIN_COMPARISON_BYTES = 4 * 1024 * 1024 * 1024;
export const MAX_UNCERTAIN_COMPARISON_ENTRIES = 250_000;
/** Bound startup enumeration/accounting for adjacent stale world roots. */
export const MAX_STALE_SWEEP_BYTES = MAX_UNCERTAIN_COMPARISON_BYTES;
/** Minimum durable session envelope reserved for every creator transaction. */
export const MIN_UNCERTAIN_COMPARISON_RESERVATION_BYTES = MAX_SESSION_BYTES;
/** Atomic root-scoped usage ledger for uncertain comparison evidence. */
export const UNCERTAIN_COMPARISON_USAGE_LEDGER = ".termina-uncertain-comparison-usage.json";
export const UNCERTAIN_COMPARISON_USAGE_LEDGER_VERSION = 1;
export const MAX_UNCERTAIN_COMPARISON_ROOT_ENTRIES = MAX_UNCERTAIN_COMPARISONS * 4;
export const MAX_PROMOTION_SCAN_ENTRIES = MAX_UNCERTAIN_COMPARISON_ENTRIES;
export const MAX_PROMOTION_SCAN_DEPTH = 64;
export const MAX_PROMOTION_SCAN_PENDING = MAX_PROMOTION_SCAN_ENTRIES;
export const MAX_PROMOTION_SCAN_WORK_BYTES = 128 * 1024 * 1024;
export const MAX_UNCERTAIN_SCAN_DEPTH = 64;
export const MAX_UNCERTAIN_SCAN_PENDING = MAX_UNCERTAIN_COMPARISON_ENTRIES;
export const MAX_UNCERTAIN_SCAN_WORK_BYTES = 128 * 1024 * 1024;

/** The app-owned marker that proves a worlds dir belongs to the app. */
export const MARKER = ".termina-world";
