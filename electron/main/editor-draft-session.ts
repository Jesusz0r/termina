import { randomUUID } from "node:crypto";
import type { ProjectWorkspaceRef } from "../../shared/types.js";
import { EditorDraftStore, MAX_EDITOR_DRAFT_BYTES } from "../editor-drafts.js";

interface DraftLease {
  root: string;
  path: string;
  owner: ProjectWorkspaceRef;
  revision: number;
  modelId: string;
  discarding?: boolean;
}

/** An opened text model grants access to one recovery copy, never to project writes. */
export class EditorDraftSession {
  private leases = new Map<string, DraftLease>();
  private tokens = new Map<string, string>();

  constructor(private readonly store: EditorDraftStore) {}

  reset(): void {
    this.leases.clear();
    this.tokens.clear();
  }

  issue(root: string, path: string, owner: ProjectWorkspaceRef, modelId: string): { token: string; revision: number } {
    const key = `${owner.projectId}\0${owner.workspaceId}\0${path}`;
    const previous = this.tokens.get(key);
    const lease = previous ? this.leases.get(previous) : undefined;
    if (lease?.discarding) throw new Error("editor is closing; recovery ownership is frozen");
    if (previous && lease?.modelId === modelId && lease.root === root) return { token: previous, revision: lease.revision };
    if (previous) this.leases.delete(previous);
    if (this.leases.size >= 2000) throw new Error("too many open editor recovery entries");
    const token = randomUUID();
    this.tokens.set(key, token);
    this.leases.set(token, { root, path, owner: { ...owner }, revision: 0, modelId });
    return { token, revision: 0 };
  }

  forget(token: unknown, owner: ProjectWorkspaceRef): void {
    if (typeof token !== "string") return;
    const lease = this.leases.get(token);
    if (!lease || lease.owner.projectId !== owner.projectId || lease.owner.workspaceId !== owner.workspaceId) return;
    this.leases.delete(token);
    this.tokens.delete(`${owner.projectId}\0${owner.workspaceId}\0${lease.path}`);
  }

  forgetProject(projectId: string): void {
    for (const [token, lease] of this.leases) {
      if (lease.owner.projectId === projectId) this.forget(token, lease.owner);
    }
  }

  forgetWorkspace(owner: ProjectWorkspaceRef): void {
    for (const [token, lease] of this.leases) {
      if (lease.owner.projectId === owner.projectId && lease.owner.workspaceId === owner.workspaceId) this.forget(token, owner);
    }
  }

  async discard(tokens: string[], projectId?: string): Promise<void> {
    const selected = [...new Set(tokens)].map((token) => ({ token, lease: this.leases.get(token) }))
      .filter((item): item is { token: string; lease: DraftLease } => !!item.lease);
    if (selected.some(({ lease }) => projectId !== undefined && lease.owner.projectId !== projectId)) {
      throw new Error("recovery copy belongs to another project");
    }
    if (selected.some(({ lease }) => lease.discarding)) throw new Error("editor is already closing; recovery ownership is frozen");
    for (const { lease } of selected) lease.discarding = true;
    try {
      // Freeze ownership before async validation; a reload must not let an old
      // discard delete a replacement model's newly accepted recovery copy.
      for (const { lease } of selected) await this.store.get(lease.root, lease.path);
      for (const { token, lease } of selected) {
        if (this.leases.get(token) !== lease) throw new Error("editor recovery ownership changed during close");
        await this.store.put(lease.root, lease.path, null);
      }
      for (const { token, lease } of selected) this.forget(token, lease.owner);
    } finally {
      for (const { lease } of selected) lease.discarding = false;
    }
  }

  checkpoint(token: unknown, revision: unknown, content: unknown, owner: ProjectWorkspaceRef): Promise<{ ok: boolean; error?: string }> {
    const lease = typeof token === "string" ? this.leases.get(token) : undefined;
    if (!lease || lease.discarding || lease.owner.projectId !== owner.projectId || lease.owner.workspaceId !== owner.workspaceId) {
      return Promise.resolve({ ok: false, error: "editor recovery access is no longer current" });
    }
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= lease.revision) {
      return Promise.resolve({ ok: false, error: "editor recovery revision is not current" });
    }
    if (content !== null && (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_EDITOR_DRAFT_BYTES)) {
      return Promise.resolve({ ok: false, error: "recovery copy exceeds the 2 MiB text limit" });
    }
    lease.revision = revision;
    return this.store.put(lease.root, lease.path, content).then(
      () => ({ ok: true }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  }
}
