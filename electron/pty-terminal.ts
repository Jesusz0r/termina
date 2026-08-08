/**
 * A real pi terminal: runs the pi TUI inside a pty (node-pty).
 * Output streams to the renderer's xterm; keys flow back into the pty.
 */
import { spawn, type IPty } from "@lydell/node-pty";

export interface PtyOptions {
  id: string;
  cwd: string;
  bin: string;
  eventsDir: string;
  cols: number;
  rows: number;
}

export class PtyTerminal {
  readonly id: string;
  readonly cwd: string;
  private pty: IPty | null = null;
  private exited = false;

  onData: (data: string) => void = () => {};
  onExit: (code: number) => void = () => {};

  constructor(opts: PtyOptions) {
    this.id = opts.id;
    this.cwd = opts.cwd;
    this.pty = spawn(opts.bin, [], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: {
        ...process.env,
        PI_EDITOR_TERMINAL_ID: opts.id,
        PI_EDITOR_EVENTS_DIR: opts.eventsDir,
      },
    });
    this.pty.onData((data) => this.onData(data));
    this.pty.onExit(({ exitCode }) => {
      this.exited = true;
      this.onExit(exitCode);
    });
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

  kill(): void {
    if (this.exited || !this.pty) return;
    try {
      this.pty.kill();
    } catch {
      /* ignore */
    }
  }
}