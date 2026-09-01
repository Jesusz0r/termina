/**
 * A real pi terminal: runs the pi TUI inside a pty (node-pty).
 * Output streams to the renderer's xterm; keys flow back into the pty.
 */
import { spawn, type IPty } from "@lydell/node-pty";
import { splitPtyData } from "./pty-egress.js";

interface PtyOptions {
  id: string;
  cwd: string;
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  cols: number;
  rows: number;
}

export class PtyTerminal {
  readonly id: string;
  readonly cwd: string;
  private pty: IPty | null = null;
  private exited = false;
  private flushingOutput = false;
  private pendingOutput: Array<{ data: string; offset: number }> = [];
  private pendingExitCode: number | null = null;
  private exitDelivered = false;

  onData: (data: string) => boolean | void = () => {};
  onExit: (code: number) => void = () => {};

  /** The pty child pid (the process-group leader). */
  get pid(): number {
    return this.pty?.pid ?? -1;
  }

  /**
   * Signal the whole pty process group. The pty child is a session
   * leader, so its pid is the group id; descendants inherit the group.
   */
  killGroup(signal: string = "SIGTERM"): void {
    const pid = this.pid;
    if (pid <= 0) return;
    try {
      process.kill(-pid, signal);
    } catch {
      /* the group is already gone */
    }
  }

  constructor(opts: PtyOptions) {
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.pty = spawn(opts.cmd, opts.args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    // node-pty can deliver a large read quantum. Split it before it reaches
    // the egress owner so one callback cannot bypass its byte/chunk high-water
    // marks. The native source is paused by that owner between quanta.
    this.pty.onData((data) => {
      this.pendingOutput.push({ data, offset: 0 });
      this.flushOutput();
    });
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.pendingExitCode = exitCode;
      // A native exit can race the final source pause. Keep feeding the
      // already-read tail through the bounded egress owner before announcing
      // exit; closeOutput() is the explicit cancellation path.
      this.flushOutput();
    });
  }

  /** Feed source data in bounded quanta, retaining only an unadmitted tail. */
  private flushOutput(): void {
    if (this.flushingOutput || this.pendingOutput.length === 0) {
      this.emitExitIfDrained();
      return;
    }
    this.flushingOutput = true;
    try {
      while (this.pendingOutput.length > 0) {
        const pending = this.pendingOutput[0]!;
        const remainder = pending.data.slice(pending.offset);
        const next = splitPtyData(remainder).next();
        if (next.done || next.value === undefined) {
          this.pendingOutput.shift();
          continue;
        }
        if (this.onData(next.value) === false) {
          // The egress queue has reached high-water. The same source quantum
          // is retried by resume() after acknowledgements cross low-water.
          this.pause();
          break;
        }
        pending.offset += next.value.length;
        if (pending.offset >= pending.data.length) this.pendingOutput.shift();
      }
    } finally {
      this.flushingOutput = false;
    }
    this.emitExitIfDrained();
  }

  private emitExitIfDrained(): void {
    if (this.pendingExitCode === null || this.pendingOutput.length > 0 || this.exitDelivered) return;
    this.exitDelivered = true;
    const code = this.pendingExitCode;
    this.pendingExitCode = null;
    this.onExit(code);
  }

  /** Discard source data only for an intentional user/app close. */
  cancelOutput(): void {
    this.pendingOutput.length = 0;
    this.emitExitIfDrained();
  }

  write(data: string): void {
    if (this.exited || !this.pty) return;
    try {
      this.pty.write(data);
    } catch {
      /* ignore */
    }
  }

  resize(cols: number, rows: number): void {
    if (this.exited || !this.pty) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      /* ignore */
    }
  }

  kill(signal?: string): void {
    if (this.exited || !this.pty) return;
    try {
      this.pty.kill(signal);
    } catch {
      /* ignore */
    }
  }

  /** Apply source backpressure without exposing node-pty to the app owner. */
  pause(): void {
    if (this.exited || !this.pty) return;
    try {
      this.pty.pause();
    } catch {
      /* A concurrently exiting pty is already paused in practice. */
    }
  }

  resume(): void {
    if (!this.exited && this.pty) {
      try {
        this.pty.resume();
      } catch {
        /* A concurrently exiting pty has no more data to resume. */
      }
    }
    // Resume also drains a callback tail that was held at egress high-water.
    this.flushOutput();
  }
}
