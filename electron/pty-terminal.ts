/**
 * A real agent terminal: runs the agent TUI inside a pty (node-pty).
 * Output streams to the renderer's xterm; keys flow back into the pty.
 */
import { spawn, type IPty } from "@lydell/node-pty";
import { splitPtyData } from "./pty-egress.js";

/** Defense-in-depth bound on queued PTY input: an IPC burst must not grow
 *  the queue without limit while the chunked writer drains it. Payloads
 *  past this are dropped with a warning; honest renderers never approach it. */
export const MAX_PENDING_INPUT_BYTES = 16 * 1024 * 1024;

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
  /** Ordered PTY input. Large pastes are written in yielded chunks so they
   * cannot monopolize Electron's main thread or flood node-pty in one call. */
  private pendingInput: Array<{ data: string; offset: number }> = [];
  /** Unwritten input chars; the queue drops payloads past MAX_PENDING_INPUT_BYTES. */
  private pendingInputBytes = 0;
  private inputScheduled = false;

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
      this.pendingInput.length = 0;
      this.pendingInputBytes = 0;
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
        // Slice once per quantum: the generator walks the tail without
        // re-slicing the remainder before every chunk.
        for (const chunk of splitPtyData(pending.data.slice(pending.offset))) {
          if (this.onData(chunk) === false) {
            // The egress queue has reached high-water. The same source quantum
            // is retried by resume() after acknowledgements cross low-water.
            this.pause();
            break;
          }
          pending.offset += chunk.length;
        }
        if (pending.offset >= pending.data.length) this.pendingOutput.shift();
        else break;
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
    if (this.exited || !this.pty || data.length === 0) return;
    if (this.pendingInputBytes + data.length > MAX_PENDING_INPUT_BYTES) {
      console.warn(`[pty] dropping ${data.length} chars of input: ${this.pendingInputBytes} chars already queued`);
      return;
    }
    this.pendingInput.push({ data, offset: 0 });
    this.pendingInputBytes += data.length;
    this.scheduleInput();
  }

  /** Cancel queued input and deliver Ctrl+C without waiting behind a paste. */
  interrupt(): void {
    if (this.exited || !this.pty) return;
    this.pendingInput.length = 0;
    this.pendingInputBytes = 0;
    try {
      this.pty.write("\x03");
    } catch {
      /* ignore */
    }
  }

  private scheduleInput(): void {
    if (this.inputScheduled || this.exited || !this.pty || this.pendingInput.length === 0) return;
    this.inputScheduled = true;
    setImmediate(() => {
      this.inputScheduled = false;
      this.flushInputChunk();
    });
  }

  private flushInputChunk(): void {
    if (this.exited || !this.pty) {
      this.pendingInput.length = 0;
      this.pendingInputBytes = 0;
      return;
    }
    const pending = this.pendingInput[0];
    if (!pending) return;
    const maxEnd = Math.min(pending.data.length, pending.offset + 16 * 1024);
    // Never hand node-pty half of a surrogate pair; separate writes are
    // encoded independently by its native boundary.
    const end = maxEnd < pending.data.length
      && pending.data.charCodeAt(maxEnd - 1) >= 0xd800
      && pending.data.charCodeAt(maxEnd - 1) <= 0xdbff
      ? maxEnd - 1
      : maxEnd;
    try {
      this.pty.write(pending.data.slice(pending.offset, end));
    } catch {
      this.pendingInput.length = 0;
      this.pendingInputBytes = 0;
      return;
    }
    this.pendingInputBytes -= end - pending.offset;
    pending.offset = end;
    if (pending.offset >= pending.data.length) this.pendingInput.shift();
    this.scheduleInput();
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
    const name = signal ?? "SIGTERM";
    // Signal the group even after node-pty has reported exit. The session
    // leader (spawn-helper on macOS) can still be alive after the shell exits.
    this.killGroup(name);
    if (this.exited || !this.pty) return;
    this.pendingInput.length = 0;
    this.pendingInputBytes = 0;
    try {
      this.pty.kill(name);
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
