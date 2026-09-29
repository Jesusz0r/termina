/** One bounded worker per fallback search; at most one file is in flight. */
import { Worker } from "node:worker_threads";

export interface LineMatch {
  line: number;
  column: number;
  matchLength: number;
  /** Slice of the line containing the match, not necessarily the whole line. */
  text: string;
  /** UTF-16 index of `text` in the line. */
  sliceStart: number;
  /** Length of the line after a trailing CR is stripped. */
  lineLength: number;
}

export class ContentLineMatcher {
  private readonly worker: Worker;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly poll: ReturnType<typeof setInterval>;
  private pending: ((matches: LineMatch[]) => void) | null = null;
  private termination: Promise<number> | null = null;
  private failure: Error | null = null;
  stopped = false;
  timedOut = false;
  invalid = false;

  constructor(pattern: string, shouldStop: () => boolean, budgetMs: number) {
    // Source tests run the TypeScript entry with type stripping. Packaged and
    // dev main use the bundled sibling from the canonical bundle definitions.
    const fromSource = import.meta.url.endsWith(".ts");
    this.worker = new Worker(new URL(fromSource ? "./match-lines.ts" : "./content-search-worker.mjs", import.meta.url), {
      workerData: { pattern },
      ...(fromSource ? { execArgv: ["--experimental-strip-types"] } : {}),
    });
    this.worker.on("message", (matches: LineMatch[] | null) => {
      this.invalid = matches === null;
      this.settle(matches ?? []);
    });
    this.worker.on("error", (error) => { this.failure = error; this.stop(); });
    this.worker.on("exit", () => {
      if (!this.stopped) { this.failure = new Error("content search worker exited before completing"); this.stop(); }
    });
    this.timer = setTimeout(() => { this.timedOut = true; this.stop(); }, budgetMs);
    this.poll = setInterval(() => { if (shouldStop()) this.stop(); }, 20);
  }

  private settle(matches: LineMatch[]): void {
    const pending = this.pending;
    this.pending = null;
    pending?.(matches);
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.poll);
    this.settle([]);
    this.termination = this.worker.terminate();
  }

  async match(content: string, limit: number, previewLength: number): Promise<LineMatch[]> {
    if (this.failure) throw this.failure;
    if (this.stopped) return [];
    const matches = await new Promise<LineMatch[]>((resolve) => {
      this.pending = resolve;
      this.worker.postMessage({ content, limit, previewLength });
    });
    if (this.failure) throw this.failure;
    return matches;
  }

  async dispose(): Promise<void> {
    this.stop();
    await this.termination;
  }
}
