import type { ProjectWorkspaceRef } from "../shared/types";

interface DraftBindings {
  checkpoint(token: string, revision: number, content: string | null, owner: ProjectWorkspaceRef): Promise<{ ok: boolean; error?: string }>;
  status(state: "pending" | "saved" | "failed", error?: string): void;
}

/** Keep at most one submitted copy and one latest edit, not a queue of full models. */
export class EditorDraftCheckpoint {
  private pending: { revision: number; content: string | null } | null = null;
  private running: Promise<void> | null = null;
  private failed = false;

  constructor(
    readonly token: string,
    private revision: number,
    private owner: ProjectWorkspaceRef,
    private bindings: DraftBindings,
  ) {}

  update(content: string | null): void {
    this.pending = { revision: ++this.revision, content };
    this.bindings.status("pending");
    if (!this.running) this.running = Promise.resolve().then(() => this.drain());
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const copy = this.pending;
      this.pending = null;
      try {
        const result = await this.bindings.checkpoint(this.token, copy.revision, copy.content, this.owner);
        if (!result.ok) throw new Error(result.error ?? "recovery copy could not be saved");
        this.failed = false;
        if (copy.revision === this.revision) this.bindings.status("saved");
      } catch (error) {
        this.failed = true;
        this.bindings.status("failed", error instanceof Error ? error.message : String(error));
      }
    }
    this.running = null;
  }

  async flush(): Promise<boolean> {
    while (this.running) await this.running;
    return !this.failed;
  }
}
