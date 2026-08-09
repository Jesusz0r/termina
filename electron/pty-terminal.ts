/**
 * A real pi terminal: runs the pi TUI inside a pty (node-pty).
 * Output streams to the renderer's xterm; keys flow back into the pty.
 */
import { spawn, type IPty } from "@lydell/node-pty";

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

  onData: (data: string) => void = () => {};
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

  kill(signal?: string): void {
    if (this.exited || !this.pty) return;
    try {
      this.pty.kill(signal);
    } catch {
      /* ignore */
    }
  }
}