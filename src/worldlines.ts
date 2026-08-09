/**
 * Worldlines panel (WORLDLINES §6.9): one card per candidate pair with
 * lifecycle, model, Verify, reopen, discard, and on-demand details
 * (source statistics, provenance, runtime age, dependency changes).
 * Comparison opens in Change Review.
 *
 * DOM updates are incremental: an update push touches only its card.
 */
import type { WorldlineSummary, WorldlineDetails, WorldlineChangedFile } from "../shared/types";
import { showConfirm, toast } from "./components/modals";

interface ViewHandlers {
  /** Open a base-to-candidate diff in Change Review. */
  onCompareBase(comparisonId: string, label: "A" | "B", relPath: string, absPath: string): void;
  /** Open an A-to-B diff in Change Review. */
  onCompareAB(comparisonId: string, relPath: string): void;
  /** Open an absolute candidate path in the editor. */
  onOpenFile(absPath: string): void;
}

const STATE_LABELS: Record<string, string> = {
  creating: "creating",
  ready: "ready",
  running: "running",
  settled: "settled",
  verifying: "verifying",
  promoting: "promoting",
  conflict: "conflict",
  cancelled: "cancelled",
  error: "error",
  discarding: "discarding",
  discarded: "discarded",
  promoted: "promoted",
};

interface CandidateCard {
  summary: WorldlineSummary;
  el: HTMLElement;
  stateEl: HTMLElement;
  detailsEl: HTMLElement;
  detailsBody: HTMLElement;
  changedList: HTMLElement;
  details: WorldlineDetails | null;
  detailsLoading: boolean;
}

interface PairView {
  comparisonId: string;
  block: HTMLElement;
  runEl: HTMLElement;
  cards: Map<"A" | "B", CandidateCard>;
}

export class WorldlinesView {
  private listEl: HTMLElement;
  private countEl: HTMLElement;
  private panel: HTMLElement;
  private pairs = new Map<string, PairView>();
  /** terminalId → label, for terminal tab badges. */
  private byTerminal = new Map<string, "A" | "B">();
  /** candidate root → label, for editor tab badges. */
  private byRoot = new Map<string, "A" | "B">();

  private handlers: ViewHandlers = {
    onCompareBase: () => {},
    onCompareAB: () => {},
    onOpenFile: () => {},
  };

  constructor(panel: HTMLElement) {
    this.panel = panel;
    this.listEl = panel.querySelector("#worldline-list")!;
    this.countEl = panel.querySelector("#worldline-count")!;
    panel.querySelector(".panel-header")?.addEventListener("click", () => panel.classList.toggle("collapsed"));
  }

  bind(handlers: Partial<ViewHandlers>): void {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /** The candidate label of a terminal, or null. */
  labelOfTerminal(terminalId: string): "A" | "B" | null {
    return this.byTerminal.get(terminalId) ?? null;
  }

  /** The candidate label owning a path, or null. */
  labelOfPath(path: string): "A" | "B" | null {
    for (const [root, label] of this.byRoot) {
      if (path === root || path.startsWith(root + "/")) return label;
    }
    return null;
  }

  /** The candidate root of one pair member, or null. */
  rootOf(comparisonId: string, label: "A" | "B"): string | null {
    return this.pairs.get(comparisonId)?.cards.get(label)?.summary.root ?? null;
  }

  private refreshCount(): void {
    this.countEl.textContent = this.pairs.size ? `(${this.pairs.size})` : "";
    this.panel.classList.toggle("collapsed", this.pairs.size === 0);
  }

  /** One candidate summary changed (push or initial list). */
  upsert(summary: WorldlineSummary): void {
    let pair = this.pairs.get(summary.comparisonId);
    if (!pair) pair = this.makePair(summary.comparisonId);
    pair.runEl.textContent = summary.sourceRunId;
    pair.runEl.title = `source run ${summary.sourceRunId}`;
    const card = pair.cards.get(summary.label)!;
    const prev = card.summary;
    card.summary = summary;
    if (summary.terminalId) this.byTerminal.set(summary.terminalId, summary.label);
    if (summary.terminalId && prev.terminalId && summary.terminalId !== prev.terminalId) {
      this.byTerminal.delete(prev.terminalId);
    }
    this.byRoot.set(summary.root, summary.label);
    this.renderCard(card);
  }

  /** A whole comparison was removed. */
  remove(comparisonId: string): void {
    const pair = this.pairs.get(comparisonId);
    if (!pair) return;
    for (const card of pair.cards.values()) {
      if (card.summary.terminalId) this.byTerminal.delete(card.summary.terminalId);
      this.byRoot.delete(card.summary.root);
    }
    pair.block.remove();
    this.pairs.delete(comparisonId);
    this.refreshCount();
  }

  private makePair(comparisonId: string): PairView {
    const block = document.createElement("div");
    block.className = "comparison";
    block.dataset.cmp = comparisonId;

    const head = document.createElement("div");
    head.className = "comparison-head";
    const idEl = document.createElement("span");
    idEl.className = "cmp-id";
    idEl.textContent = comparisonId;
    const runEl = document.createElement("span");
    runEl.className = "cmp-run muted";
    runEl.textContent = "…";
    const spacer = document.createElement("div");
    spacer.className = "spacer";
    const abBtn = document.createElement("button");
    abBtn.className = "cmp-ab";
    abBtn.textContent = "A ⇄ B";
    abBtn.title = "Compare the A and B heads file by file";
    abBtn.addEventListener("click", () => void this.openABCompare(comparisonId));
    const discardBtn = document.createElement("button");
    discardBtn.className = "cmp-discard";
    discardBtn.textContent = "Discard";
    discardBtn.title = "Discard this comparison and remove every app-owned resource";
    discardBtn.addEventListener("click", () => void this.confirmDiscard(comparisonId));
    head.append(idEl, runEl, spacer, abBtn, discardBtn);

    const row = document.createElement("div");
    row.className = "candidate-row";

    const pair: PairView = { comparisonId, block, runEl, cards: new Map() };
    for (const label of ["A", "B"] as const) {
      const card = this.makeCard(comparisonId, label);
      pair.cards.set(label, card);
      row.appendChild(card.el);
    }
    block.append(head, row);
    this.listEl.appendChild(block);
    this.pairs.set(comparisonId, pair);
    this.refreshCount();
    return pair;
  }

  private makeCard(comparisonId: string, label: "A" | "B"): CandidateCard {
    const el = document.createElement("div");
    el.className = `candidate-card cand-${label.toLowerCase()}`;
    el.dataset.cmp = comparisonId;
    el.dataset.label = label;

    const head = document.createElement("div");
    head.className = "cand-head";
    const badge = document.createElement("span");
    badge.className = `cand-badge ${label.toLowerCase()}`;
    badge.textContent = label;
    const role = document.createElement("span");
    role.className = "cand-role";
    const stateEl = document.createElement("span");
    stateEl.className = "cand-state";
    const spacer = document.createElement("div");
    spacer.className = "spacer";
    const detailsBtn = document.createElement("button");
    detailsBtn.className = "cand-details";
    detailsBtn.textContent = "▾";
    detailsBtn.title = "Show source statistics, provenance, and dependency changes";
    detailsBtn.addEventListener("click", () => this.toggleDetails(comparisonId, label, false));
    head.append(badge, role, stateEl, spacer, detailsBtn);

    const meta = document.createElement("div");
    meta.className = "cand-meta";

    const detailsBody = document.createElement("div");
    detailsBody.className = "cand-details-body";
    detailsBody.hidden = true;
    const stats = document.createElement("div");
    stats.className = "cand-stats";
    const deps = document.createElement("div");
    deps.className = "cand-deps";
    const changedTitle = document.createElement("div");
    changedTitle.className = "cand-changed-title";
    changedTitle.textContent = "Changed vs base";
    const changedList = document.createElement("ul");
    changedList.className = "cand-changed";
    detailsBody.append(stats, deps, changedTitle, changedList);

    const actions = document.createElement("div");
    actions.className = "cand-actions";
    const promoteBtn = document.createElement("button");
    promoteBtn.className = "cand-promote";
    promoteBtn.textContent = "⇧ Promote";
    promoteBtn.title = "Merge this candidate into the primary project";
    promoteBtn.addEventListener("click", () => void this.promote(comparisonId, label));
    const verifyBtn = document.createElement("button");
    verifyBtn.className = "cand-verify";
    verifyBtn.textContent = "✓ Verify";
    verifyBtn.title = "Run the detected tests inside the candidate sandbox";
    verifyBtn.addEventListener("click", () => void this.verify(comparisonId, label));
    const compareBtn = document.createElement("button");
    compareBtn.className = "cand-compare";
    compareBtn.textContent = "Compare";
    compareBtn.title = "Diff the candidate head against the shared base";
    compareBtn.addEventListener("click", () => this.toggleDetails(comparisonId, label, true));
    const openBtn = document.createElement("button");
    openBtn.className = "cand-open";
    openBtn.textContent = "Open";
    openBtn.title = "Reopen the candidate Pi terminal";
    openBtn.addEventListener("click", () => void this.reopen(comparisonId, label));
    actions.append(promoteBtn, verifyBtn, compareBtn, openBtn);

    el.append(head, meta, detailsBody, actions);

    const card: CandidateCard = {
      summary: { id: `${comparisonId}-${label.toLowerCase()}`, comparisonId, label, role: label === "A" ? "reference" : "alternative", state: "creating", error: null, root: "", sessionFile: null, model: null, thinkingLevel: null, createdAt: 0, terminalId: null, version: 0, comparisonBaseStateId: "", promotionBaseStateId: "", headStateId: "", sourceRunId: "" },
      el,
      stateEl,
      detailsEl: detailsBody,
      detailsBody,
      changedList,
      details: null,
      detailsLoading: false,
    };
    return card;
  }

  private renderCard(card: CandidateCard): void {
    const s = card.summary;
    card.el.querySelector(".cand-role")!.textContent = s.role;
    card.el.querySelector(".cand-meta")!.textContent =
      [s.model, s.thinkingLevel].filter(Boolean).join(" · ") || "model unknown";
    card.stateEl.textContent = STATE_LABELS[s.state] ?? s.state;
    card.stateEl.className = `cand-state state-${s.state}`;
    card.el.title = s.error ? `error: ${s.error}` : "";
    card.el.classList.toggle("has-error", s.state === "error" || s.state === "conflict");
    const verifyBtn = card.el.querySelector(".cand-verify") as HTMLButtonElement;
    const openBtn = card.el.querySelector(".cand-open") as HTMLButtonElement;
    const promoteBtn = card.el.querySelector(".cand-promote") as HTMLButtonElement;
    const usable =
      s.terminalId !== null && !["creating", "discarding", "discarded", "promoted", "cancelled", "error"].includes(s.state);
    verifyBtn.disabled = !usable;
    openBtn.disabled = !s.sessionFile;
    promoteBtn.disabled = !usable || !s.sessionFile;
    promoteBtn.textContent = s.state === "promoting" ? "⇧ promoting…" : "⇧ Promote";
    // The details stay valid while the card lives; refresh them on state
    // changes only when the user already opened them.
    if (!card.detailsBody.hidden && card.details) this.fillDetails(card, card.details);
  }

  // ------------------------------------------------------------ actions ----

  private async promote(comparisonId: string, label: "A" | "B"): Promise<void> {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    if (!card) return;
    const s = card.summary;
    void showConfirm(
      "Promote candidate",
      `Merge candidate ${label} (${s.role}) into the primary project? The three-way merge uses the run start as the base.`,
    ).then(async (r) => {
      if (!r.confirmed) return;
      const res = await window.pi.promoteWorldline(comparisonId, label);
      if (!res.ok) toast(`promotion failed: ${res.error ?? "unknown error"}`, "warning");
      else toast(`candidate ${label} promoted — opening the result in a new terminal`, "info");
    });
  }

  private async verify(comparisonId: string, label: "A" | "B"): Promise<void> {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    if (!card?.summary.terminalId) return;
    const res = await window.pi.runVerify(card.summary.terminalId);
    if (!res.ok) toast(res.error ?? "verify failed to start", "warning");
  }

  private async reopen(comparisonId: string, label: "A" | "B"): Promise<void> {
    const res = await window.pi.openWorldlineTerminal(comparisonId, label);
    if (!res.ok) toast(res.error ?? "could not reopen the candidate", "warning");
    else toast(`candidate ${label} reopened`, "info");
  }

  private confirmDiscard(comparisonId: string): void {
    void showConfirm("Discard worldline", `Remove comparison ${comparisonId} and every app-owned candidate resource?`).then((r) => {
      if (!r.confirmed) return;
      void window.pi.discardWorldline(comparisonId).then((res) => {
        if (!res.ok) toast(res.error ?? "discard failed", "warning");
      });
    });
  }

  /** Expand the changed-files list for a candidate (details load lazily). */
  private toggleDetails(comparisonId: string, label: "A" | "B", forceOpen: boolean): void {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    if (!card) return;
    if (!card.detailsBody.hidden && !forceOpen) {
      card.detailsBody.hidden = true;
      return;
    }
    card.detailsBody.hidden = false;
    if (!card.details && !card.detailsLoading) {
      card.detailsLoading = true;
      card.changedList.replaceChildren();
      const li = document.createElement("li");
      li.className = "cand-loading";
      li.textContent = "computing…";
      card.changedList.appendChild(li);
      void window.pi.getWorldlineDetails(comparisonId, label).then((res) => {
        card.detailsLoading = false;
        if (!res.ok || !res.details) {
          card.changedList.replaceChildren();
          const err = document.createElement("li");
          err.className = "cand-loading";
          err.textContent = res.error ?? "details unavailable";
          card.changedList.appendChild(err);
          return;
        }
        card.details = res.details;
        this.fillDetails(card, res.details);
      });
    }
  }

  private fillDetails(card: CandidateCard, d: WorldlineDetails): void {
    const statsEl = card.detailsBody.querySelector(".cand-stats")!;
    const depsEl = card.detailsBody.querySelector(".cand-deps")!;
    const age = d.ageMs < 60_000 ? `${Math.max(1, Math.round(d.ageMs / 1000))} s` : `${Math.round(d.ageMs / 60_000)} min`;
    statsEl.textContent = `${d.sourceFiles} files · ${formatBytes(d.sourceBytes)} · ${d.changedFiles.length} changed · ${age} old`;
    depsEl.textContent = "";
    for (const dep of d.dependencies) {
      const parts: string[] = [];
      if (dep.added.length) parts.push(`+${dep.added.join(", +")}`);
      if (dep.removed.length) parts.push(`−${dep.removed.join(", −")}`);
      if (dep.changed.length) parts.push(`~${dep.changed.join(", ~")}`);
      const row = document.createElement("div");
      row.textContent = `${dep.file}: ${parts.join("  ")}`;
      depsEl.appendChild(row);
    }
    card.detailsBody.querySelector(".cand-changed-title")!.textContent = `Changed vs base (${d.changedFiles.length})`;
    card.changedList.replaceChildren();
    for (const f of d.changedFiles) {
      const li = document.createElement("li");
      li.className = "cand-changed-item";
      const badge = document.createElement("span");
      badge.className = `status-badge ${f.status}`;
      badge.textContent = f.status === "created" ? "A" : f.status === "deleted" ? "D" : "M";
      const path = document.createElement("span");
      path.className = "path";
      path.textContent = f.relPath;
      li.append(badge, path);
      li.title = `Compare base → ${card.summary.label} for ${f.relPath}`;
      li.addEventListener("click", () => {
        const root = this.rootOf(card.summary.comparisonId, card.summary.label);
        if (!root) return;
        this.handlers.onCompareBase(card.summary.comparisonId, card.summary.label, f.relPath, `${root}/${f.relPath}`);
      });
      card.changedList.appendChild(li);
    }
  }

  /** The union of both candidates' changed files, for the A ⇄ B list. */
  private async openABCompare(comparisonId: string): Promise<void> {
    const pair = this.pairs.get(comparisonId);
    if (!pair) return;
    const [a, b] = await Promise.all([
      this.detailsOf(comparisonId, "A"),
      this.detailsOf(comparisonId, "B"),
    ]);
    if (!a || !b) return;
    const byPath = new Map<string, { status: WorldlineChangedFile["status"]; inA: boolean; inB: boolean }>();
    const add = (f: WorldlineChangedFile, inA: boolean, inB: boolean): void => {
      const prev = byPath.get(f.relPath);
      const prevInA = prev ? prev.inA : false;
      const prevInB = prev ? prev.inB : false;
      byPath.set(f.relPath, { status: f.status, inA: inA || prevInA, inB: inB || prevInB });
    };
    for (const f of a.changedFiles) add(f, true, false);
    for (const f of b.changedFiles) add(f, false, true);
    this.openListModal(
      `A ⇄ B — ${byPath.size} file(s)`,
      [...byPath.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([relPath, f]) => [relPath, f.status] as [string, WorldlineChangedFile["status"]]),
      (relPath) => this.handlers.onCompareAB(comparisonId, relPath),
    );
  }

  /** Fetch (or reuse) the details of one candidate. */
  private async detailsOf(comparisonId: string, label: "A" | "B"): Promise<WorldlineDetails | null> {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    if (!card) return null;
    if (card.details) return card.details;
    const res = await window.pi.getWorldlineDetails(comparisonId, label);
    if (res.ok && res.details) {
      card.details = res.details;
      return res.details;
    }
    toast(res.error ?? "details unavailable", "warning");
    return null;
  }

  /** A small modal with a clickable file list. */
  private openListModal(title: string, items: Array<[string, WorldlineChangedFile["status"]]>, onPick: (relPath: string) => void): void {
    const root = document.getElementById("modal-root")!;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.tabIndex = -1;
    const modal = document.createElement("div");
    modal.className = "modal worldline-list-modal";
    const titleEl = document.createElement("div");
    titleEl.className = "modal-title";
    titleEl.textContent = title;
    const body = document.createElement("div");
    body.className = "modal-body";
    const list = document.createElement("ul");
    list.className = "worldline-list";
    for (const [relPath, status] of items) {
      const li = document.createElement("li");
      const badge = document.createElement("span");
      badge.className = `status-badge ${status}`;
      badge.textContent = status === "created" ? "A" : status === "deleted" ? "D" : "M";
      const path = document.createElement("span");
      path.className = "path";
      path.textContent = relPath;
      li.append(badge, path);
      li.addEventListener("click", () => {
        backdrop.remove();
        onPick(relPath);
      });
      list.appendChild(li);
    }
    body.appendChild(list);
    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal-btn";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => backdrop.remove());
    footer.appendChild(closeBtn);
    modal.append(titleEl, body, footer);
    backdrop.append(modal);
    root.appendChild(backdrop);
    backdrop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") backdrop.remove();
    });
    backdrop.focus();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
