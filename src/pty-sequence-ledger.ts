/**
 * Bounded renderer-side PTY sequence admission.
 *
 * The main process owns the lossless queue. The renderer only needs a small
 * admission ledger so a replayed sequence is acknowledged without writing
 * its bytes twice. A contiguous high-water mark handles the normal stream in
 * O(1) space; records that arrive ahead of a hole live in a fixed-size gap
 * window and are flushed in sequence order when the hole closes.
 */

export const PTY_RENDERER_SEQUENCE_GAP_WINDOW = 128;

export type PtySequenceRecord =
  | { kind: "data"; sequence: number; data: string }
  | { kind: "exit"; sequence: number; code: number };

export type PtySequenceResult =
  | { kind: "accepted"; records: PtySequenceRecord[] }
  | { kind: "buffered" }
  | { kind: "duplicate" }
  | { kind: "rejected" };

export interface PtySequenceLedgerOptions {
  /** Maximum number of sequence holes retained ahead of the watermark. */
  maxGap?: number;
}

export interface PtySequenceLedgerStats {
  /** Largest contiguous sequence accepted by this document. */
  contiguousSequence: number;
  /** Number of out-of-order records retained while holes close. */
  gapCount: number;
  /** Configured maximum forward distance for one gap. */
  gapWindow: number;
  /** Alias useful to memory-bound probes and diagnostics. */
  retainedRecords: number;
}

function isValidRecord(record: PtySequenceRecord): boolean {
  if (!record || !Number.isSafeInteger(record.sequence) || record.sequence < 1) return false;
  if (record.kind === "data") return typeof record.data === "string";
  if (record.kind === "exit") return Number.isSafeInteger(record.code);
  return false;
}

function copyRecord(record: PtySequenceRecord): PtySequenceRecord {
  return record.kind === "data"
    ? { kind: "data", sequence: record.sequence, data: record.data }
    : { kind: "exit", sequence: record.sequence, code: record.code };
}

/** Sequence admission for one PTY generation and one renderer document. */
export class PtySequenceLedger {
  private readonly maxGap: number;
  private contiguousSequence = 0;
  private initialized = false;
  private finished = false;
  private pendingExitSequence: number | null = null;
  private readonly gaps = new Map<number, PtySequenceRecord>();

  constructor(options: PtySequenceLedgerOptions = {}) {
    const maxGap = options.maxGap ?? PTY_RENDERER_SEQUENCE_GAP_WINDOW;
    if (!Number.isSafeInteger(maxGap) || maxGap < 1) throw new Error("invalid PTY renderer sequence gap window");
    this.maxGap = maxGap;
  }

  /**
   * Admit one incoming record. The first record establishes a replay
   * baseline because a fresh document may legitimately start at a sequence
   * greater than one after the main process has retired an earlier prefix.
   */
  accept(record: PtySequenceRecord): PtySequenceResult {
    if (!isValidRecord(record)) return { kind: "rejected" };

    if (!this.initialized) {
      this.initialized = true;
      this.contiguousSequence = record.sequence - 1;
    }

    if (record.sequence <= this.contiguousSequence || this.gaps.has(record.sequence)) {
      return { kind: "duplicate" };
    }
    if (this.finished) return { kind: "rejected" };
    // An exit is a terminal barrier. Do not retain or later reorder records
    // that claim to come after a marker already admitted ahead of a hole.
    if (this.pendingExitSequence !== null && record.sequence > this.pendingExitSequence) {
      return { kind: "rejected" };
    }

    const distance = record.sequence - this.contiguousSequence;
    if (distance > this.maxGap) return { kind: "rejected" };

    const owned = copyRecord(record);
    if (distance > 1) {
      this.gaps.set(record.sequence, owned);
      if (owned.kind === "exit") this.pendingExitSequence = owned.sequence;
      return { kind: "buffered" };
    }

    const ready: PtySequenceRecord[] = [owned];
    this.contiguousSequence = record.sequence;
    if (owned.kind === "exit") {
      this.finished = true;
      this.gaps.clear();
      return { kind: "accepted", records: ready };
    }
    while (true) {
      const next = this.gaps.get(this.contiguousSequence + 1);
      if (!next) break;
      this.gaps.delete(next.sequence);
      this.contiguousSequence = next.sequence;
      ready.push(next);
      if (next.kind === "exit") {
        this.finished = true;
        this.gaps.clear();
        break;
      }
    }
    return { kind: "accepted", records: ready };
  }

  /** Start a fresh PTY/document generation without retaining old records. */
  reset(): void {
    this.contiguousSequence = 0;
    this.initialized = false;
    this.finished = false;
    this.pendingExitSequence = null;
    this.gaps.clear();
  }

  stats(): PtySequenceLedgerStats {
    return {
      contiguousSequence: this.contiguousSequence,
      gapCount: this.gaps.size,
      gapWindow: this.maxGap,
      retainedRecords: this.gaps.size,
    };
  }
}
