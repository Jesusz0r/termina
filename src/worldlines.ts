/**
 * Worldlines panel (WORLDLINES §6.9): one card per candidate pair with
 * lifecycle, model, Verify, reopen, discard, and on-demand details
 * (source statistics, provenance, runtime age, dependency changes).
 * Comparison opens in Change Review.
 *
 * DOM updates are incremental: an update push touches only its card.
 */
import { CHALLENGE_PROFILES, type ChallengeProfile, type WorldlineSummary, type WorldlineDetails, type WorldlineChangedFile, type EvidenceSummary } from "../shared/types";
import { showConfirm, showFileListModal, toast } from "./components/modals";
import { KIND_LABEL, chipText, evidenceLineDetail, formatBytes, profileCaption, recordOf } from "./worldline-evidence";

interface ViewHandlers {
  /** Open a base-to-candidate diff in Change Review. */
  onCompareBase(comparisonId: string, label: "A" | "B", relPath: string, absPath: string): void;
  /** Open an A-to-B diff in Change Review. */
  onCompareAB(comparisonId: string, relPath: string): void;
  /** Open an absolute candidate path in the editor. */
  onOpenFile(absPath: string): void;
  /** Focus a terminal after Open or Promote. */
  onOpenTerminal(terminalId: string): void;
  /** True when this terminal still has a live pane. */
  isLiveTerminal(terminalId: string): boolean;
}

function actionButton(className: string, label: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

interface CandidateCard {
  summary: WorldlineSummary;
  el: HTMLElement;
  stateEl: HTMLElement;
  detailsEl: HTMLElement;
  detailsBody: HTMLElement;
  changedList: HTMLElement;
  details: WorldlineDetails | null;
  /** The candidate version the cached details were fetched at. */
  detailsVersion: number | null;
  /** The version last written into the details DOM. */
  filledVersion: number | null;
  detailsLoading: boolean;
}

interface PairView {
  comparisonId: string;
  block: HTMLElement;
  runEl: HTMLElement;
  verdictsEl: HTMLElement;
  cards: Map<"A" | "B", CandidateCard>;
  evidence: EvidenceSummary | null;
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

  /** Evidence summaries keyed by comparison. */
  private evidenceByCmp = new Map<string, EvidenceSummary>();

  private handlers: ViewHandlers = {
    onCompareBase: () => {},
    onCompareAB: () => {},
    onOpenFile: () => {},
    onOpenTerminal: () => {},
    isLiveTerminal: () => false,
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

  /** One evidence summary arrived (challenge ranking). */
  upsertEvidence(summary: EvidenceSummary): void {
    this.evidenceByCmp.set(summary.comparisonId, summary);
    const pair = this.pairs.get(summary.comparisonId);
    if (!pair) return;
    pair.evidence = summary;
    this.renderVerdicts(pair);
    for (const card of pair.cards.values()) this.renderCard(card);
  }

  /** The profile verdicts strip of a comparison. */
  private renderVerdicts(pair: PairView): void {
    pair.verdictsEl.replaceChildren();
    const summary = pair.evidence;
    if (!summary) return;
    if (summary.stale) {
      const stale = document.createElement("span");
      stale.className = "verdict verdict-stale";
      stale.textContent = "stale";
      stale.title = "a candidate ran again after this evidence";
      pair.verdictsEl.appendChild(stale);
    }
    for (const v of summary.profiles) {
      const chip = document.createElement("span");
      chip.className = `verdict verdict-${v.winner}`;
      chip.textContent = chipText(v, summary);
      chip.title = v.reason;
      pair.verdictsEl.appendChild(chip);
    }
    const caption = profileCaption(summary.profiles);
    if (caption) {
      const cap = document.createElement("div");
      cap.className = "cmp-caption";
      cap.textContent = caption;
      pair.verdictsEl.appendChild(cap);
    }
  }

  /** The evidence lines inside a candidate card's details. */
  private renderEvidence(card: CandidateCard): void {
    const evidenceEl = card.el.querySelector(".cand-evidence");
    if (!evidenceEl) return;
    evidenceEl.replaceChildren();
    const summary = this.evidenceByCmp.get(card.summary.comparisonId);
    const records = summary?.byCandidate[card.summary.label];
    if (!records || records.length === 0) return;
    const other = summary.byCandidate[card.summary.label === "A" ? "B" : "A"];
    const otherLabel = card.summary.label === "A" ? "B" : "A";
    for (const rec of records) {
      const line = document.createElement("div");
      line.className = `evidence-line evidence-${rec.status}`;
      const detail = evidenceLineDetail(rec, recordOf(other, rec.kind), otherLabel);
      line.textContent = `${KIND_LABEL[rec.kind] ?? rec.kind}: ${rec.status}${detail ? ` (${detail})` : ""}`;
      line.title = rec.reason ?? "";
      evidenceEl.appendChild(line);
    }
    const verdicts = summary?.profiles;
    if (verdicts && !summary.stale) {
      for (const v of verdicts) {
        if (v.winner !== card.summary.label) continue;
        const win = document.createElement("span");
        win.className = "evidence-winner";
        win.textContent = `evidence winner — ${v.profile}`;
        win.title = v.reason;
        evidenceEl.appendChild(win);
      }
    }
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

  /** Remove every comparison when the project changes. */
  resetForProject(): void {
    for (const comparisonId of [...this.pairs.keys()]) this.remove(comparisonId);
    this.byTerminal.clear();
    this.byRoot.clear();
    this.evidenceByCmp.clear();
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
    this.evidenceByCmp.delete(comparisonId);
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
    const challengeLabels: Record<ChallengeProfile, string> = {
      "fewer-dependencies": "Deps",
      "preserve-api": "API",
      "simpler-implementation": "Simple",
      "performance-first": "Perf",
    };
    const challengeButtons = CHALLENGE_PROFILES.map((profile) => {
      const label = challengeLabels[profile];
      const btn = actionButton("cmp-challenge", label, `Challenge with ${profile}`, () => void this.challenge(comparisonId, profile));
      btn.dataset.profile = profile;
      return btn;
    });
    const evidenceBtn = actionButton("cmp-evidence", "Evidence", "Run the evidence contract for both candidates and rank the profiles", () => void this.evidence(comparisonId));
    const abBtn = actionButton("cmp-ab", "A ⇄ B", "Compare the A and B heads file by file", () => void this.openABCompare(comparisonId));
    const discardBtn = actionButton("cmp-discard", "Discard", "Discard this comparison and remove every app-owned resource", () => void this.confirmDiscard(comparisonId));
    head.append(idEl, runEl, spacer, ...challengeButtons, evidenceBtn, abBtn, discardBtn);

    const verdictsEl = document.createElement("div");
    verdictsEl.className = "cmp-verdicts";

    const row = document.createElement("div");
    row.className = "candidate-row";

    const pair: PairView = { comparisonId, block, runEl, verdictsEl, cards: new Map(), evidence: null };
    for (const label of ["A", "B"] as const) {
      const card = this.makeCard(comparisonId, label);
      pair.cards.set(label, card);
      row.appendChild(card.el);
    }
    block.append(head, verdictsEl, row);
    this.listEl.appendChild(block);
    this.pairs.set(comparisonId, pair);
    this.refreshCount();
    const stored = this.evidenceByCmp.get(comparisonId);
    if (stored) {
      pair.evidence = stored;
      this.renderVerdicts(pair);
    }
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
    const detailsBtn = actionButton("cand-details", "▾", "Show source statistics, provenance, and dependency changes", () => this.toggleDetails(comparisonId, label, false));
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
    const evidenceTitle = document.createElement("div");
    evidenceTitle.className = "cand-changed-title";
    evidenceTitle.textContent = "Evidence";
    const evidenceEl = document.createElement("div");
    evidenceEl.className = "cand-evidence";
    detailsBody.append(stats, deps, changedTitle, changedList, evidenceTitle, evidenceEl);

    const actions = document.createElement("div");
    actions.className = "cand-actions";
    const promoteBtn = actionButton("cand-promote", "Promote", "Merge this candidate into the primary project", () => void this.promote(comparisonId, label));
    const verifyBtn = actionButton("cand-verify", "Verify", "Run the detected tests inside the candidate sandbox", () => void this.verify(comparisonId, label));
    const compareBtn = actionButton("cand-compare", "Compare", "Diff the candidate head against the shared base", () => void this.openBaseCompare(comparisonId, label));
    const openBtn = actionButton("cand-open", "Open", "Reopen the candidate Pi terminal", () => void this.reopen(comparisonId, label));
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
      detailsVersion: null,
      filledVersion: null,
      detailsLoading: false,
    };
    return card;
  }

  private renderCard(card: CandidateCard): void {
    const s = card.summary;
    card.el.querySelector(".cand-role")!.textContent = s.role;
    card.el.querySelector(".cand-meta")!.textContent =
      [s.model, s.thinkingLevel].filter(Boolean).join(" · ") || "model unknown";
    card.stateEl.textContent = s.state;
    card.stateEl.className = `cand-state state-${s.state}`;
    card.el.title = s.error ? `error: ${s.error}` : "";
    card.el.classList.toggle("has-error", s.state === "error" || s.state === "conflict");
    const verifyBtn = card.el.querySelector(".cand-verify") as HTMLButtonElement;
    const openBtn = card.el.querySelector(".cand-open") as HTMLButtonElement;
    const promoteBtn = card.el.querySelector(".cand-promote") as HTMLButtonElement;
    const dead = ["creating", "discarding", "discarded", "promoted", "cancelled", "error"];
    verifyBtn.disabled = !s.sessionFile || dead.includes(s.state);
    openBtn.disabled = !s.sessionFile;
    promoteBtn.disabled = !s.sessionFile || dead.includes(s.state);
    promoteBtn.textContent = s.state === "promoting" ? "promoting…" : "Promote";
    if (!card.detailsBody.hidden && card.details && card.filledVersion !== card.detailsVersion) {
      this.fillDetails(card, card.details);
    }
    this.renderEvidence(card);
    // The pair header reflects the pair shape (challenge needs both sides).
    const pair = this.pairs.get(card.summary.comparisonId);
    if (pair) this.renderPairActions(pair);
  }

  /** Enable or disable the pair actions from the candidate shapes. */
  private renderPairActions(pair: PairView): void {
    const challengeButtons = [...pair.block.querySelectorAll<HTMLButtonElement>(".cmp-challenge")];
    const evidenceBtn = pair.block.querySelector(".cmp-evidence") as HTMLButtonElement;
    const a = pair.cards.get("A");
    const b = pair.cards.get("B");
    const abBtn = pair.block.querySelector(".cmp-ab") as HTMLButtonElement;
    const bothReady = a !== undefined && b !== undefined;
    abBtn.style.display = bothReady ? "" : "none";
    for (const button of challengeButtons) button.style.display = bothReady ? "" : "none";
    const idle = (card: CandidateCard | undefined): boolean =>
      !!card && (card.summary.state === "ready" || card.summary.state === "settled");
    evidenceBtn.disabled = !(idle(a) && idle(b));
    evidenceBtn.title = evidenceBtn.disabled
      ? "evidence needs both candidates idle"
      : "Run the evidence contract for both candidates and rank the profiles";
    const aReady = !!a?.summary.sessionFile && !["creating", "running", "promoting", "discarding", "discarded", "cancelled", "error"].includes(a.summary.state);
    for (const button of challengeButtons) {
      button.disabled = !aReady;
      button.title = button.disabled
        ? "wait for candidate A to settle before Challenge"
        : `Launch the challenger with ${button.dataset.profile}`;
    }
  }

  // ------------------------------------------------------------ actions ----

  private async challenge(comparisonId: string, profile: ChallengeProfile): Promise<void> {
    const pair = this.pairs.get(comparisonId);
    const a = pair?.cards.get("A");
    if (!pair || !a) return;
    void showConfirm(
      "Launch challenge",
      `Candidate B replays the original task against the run start with the ${profile} constraint. Candidate A stays the reference. This comparison is replaced by the challenge pair.`,
    ).then(async (r) => {
      if (!r.confirmed) return;
      const res = await window.pi.challengeCandidate(comparisonId, "A", profile);
      if (!res.ok) toast(`challenge failed: ${res.error ?? "unknown error"}`, "warning");
      else toast(`challenger launched — ${res.comparisonId ?? ""}`, "info");
    });
  }

  private async evidence(comparisonId: string): Promise<void> {
    const res = await window.pi.runEvidence(comparisonId);
    if (!res.ok) toast(`evidence failed: ${res.error ?? "unknown error"}`, "warning");
  }

  private async promote(comparisonId: string, label: "A" | "B"): Promise<void> {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    if (!card) return;
    const s = card.summary;
    void showConfirm(
      "Promote candidate",
      `Merge candidate ${label} (${s.role}) into the primary project? The three-way merge uses the run start as the base.`,
    ).then(async (r) => {
      if (!r.confirmed) return;
      await this.runPromote(comparisonId, label, false);
    });
  }

  private async runPromote(comparisonId: string, label: "A" | "B", force: boolean): Promise<void> {
    const res = await window.pi.promoteWorldline(comparisonId, label, force);
    if (res.confirm) {
      const again = await showConfirm("Promote candidate", res.confirm);
      if (!again.confirmed) return;
      await this.runPromote(comparisonId, label, true);
      return;
    }
    if (!res.ok) toast(`promotion failed: ${res.error ?? "unknown error"}`, "warning");
    else {
      toast(`candidate ${label} promoted — opening the result in a new terminal`, "info");
      if (res.terminalId) this.handlers.onOpenTerminal(res.terminalId);
    }
  }

  private async verify(comparisonId: string, label: "A" | "B"): Promise<void> {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    if (!card) return;
    let terminalId = card.summary.terminalId;
    if (!terminalId || !this.handlers.isLiveTerminal(terminalId)) {
      const opened = await window.pi.openWorldlineTerminal(comparisonId, label);
      if (!opened.ok || !opened.terminalId) {
        toast(opened.error ?? "open the candidate terminal before Verify", "warning");
        return;
      }
      terminalId = opened.terminalId;
      this.handlers.onOpenTerminal(terminalId);
    }
    const res = await window.pi.runVerify(terminalId);
    if (!res.ok) toast(res.error ?? "verify failed to start", "warning");
  }

  private async reopen(comparisonId: string, label: "A" | "B"): Promise<void> {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    const liveId = card?.summary.terminalId;
    if (liveId && this.handlers.isLiveTerminal(liveId)) {
      this.handlers.onOpenTerminal(liveId);
      return;
    }
    const res = await window.pi.openWorldlineTerminal(comparisonId, label);
    if (!res.ok) toast(res.error ?? "could not reopen the candidate", "warning");
    else {
      toast(`candidate ${label} reopened`, "info");
      if (res.terminalId) this.handlers.onOpenTerminal(res.terminalId);
    }
  }

  private confirmDiscard(comparisonId: string): void {
    void showConfirm("Discard worldline", `Remove comparison ${comparisonId} and every app-owned candidate resource?`).then((r) => {
      if (!r.confirmed) return;
      void window.pi.discardWorldline(comparisonId).then((res) => {
        if (!res.ok) toast(res.error ?? "discard failed", "warning");
      });
    });
  }

  /** Expand the changed-files list for one candidate (details load lazily). */
  private async toggleDetails(comparisonId: string, label: "A" | "B", forceOpen: boolean): Promise<void> {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    if (!card) return;
    if (!card.detailsBody.hidden && !forceOpen) {
      card.detailsBody.hidden = true;
      return;
    }
    card.detailsBody.hidden = false;
    if (card.details || card.detailsLoading) return;
    card.detailsLoading = true;
    card.changedList.replaceChildren();
    const li = document.createElement("li");
    li.className = "cand-loading";
    li.textContent = "computing…";
    card.changedList.appendChild(li);
    const res = await this.fetchDetailsStable(comparisonId, label);
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
    card.detailsVersion = card.summary.version;
    this.fillDetails(card, res.details);
  }

  /** Fetch the details of one candidate. A version bump during the request
   *  means the answer describes the old head; retry until stable instead of
   *  stranding the panel on a stale result. */
  private async fetchDetailsStable(
    comparisonId: string,
    label: "A" | "B",
  ): Promise<{ ok: boolean; details?: WorldlineDetails; error?: string }> {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    if (!card) return { ok: false, error: "the candidate is gone" };
    for (let attempt = 0; attempt < 5; attempt++) {
      const version = card.summary.version;
      let res: { ok: boolean; details?: WorldlineDetails; error?: string };
      try {
        res = await window.pi.getWorldlineDetails(comparisonId, label);
      } catch (err) {
        // A rejected IPC call is final; retrying cannot fix it.
        return { ok: false, error: (err as Error).message };
      }
      if (card.summary.version === version) return res;
    }
    return { ok: false, error: "the candidate keeps updating — expand again" };
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

  /** The candidate's changed files versus the shared base. */
  private async openBaseCompare(comparisonId: string, label: "A" | "B"): Promise<void> {
    const details = await this.detailsOf(comparisonId, label);
    if (!details) return;
    if (details.changedFiles.length === 0) {
      toast(`candidate ${label} has no changes versus the shared base`, "info");
      return;
    }
    showFileListModal(
      `base → ${label} — ${details.changedFiles.length} file(s)`,
      details.changedFiles.map((f) => [f.relPath, f.status] as [string, WorldlineChangedFile["status"]]),
      (relPath) => {
        const root = this.rootOf(comparisonId, label);
        if (!root) return;
        this.handlers.onCompareBase(comparisonId, label, relPath, `${root}/${relPath}`);
      },
    );
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
    showFileListModal(
      `A ⇄ B — ${byPath.size} file(s)`,
      [...byPath.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([relPath, f]) => [relPath, f.status] as [string, WorldlineChangedFile["status"]]),
      (relPath) => this.handlers.onCompareAB(comparisonId, relPath),
    );
  }

  /** Fetch (or reuse) the details of one candidate. A candidate version
   *  bump invalidates the cache: the details describe the old head. */
  private async detailsOf(comparisonId: string, label: "A" | "B"): Promise<WorldlineDetails | null> {
    const card = this.pairs.get(comparisonId)?.cards.get(label);
    if (!card) return null;
    if (card.details && card.detailsVersion === card.summary.version) return card.details;
    const res = await this.fetchDetailsStable(comparisonId, label);
    if (res.ok && res.details) {
      card.details = res.details;
      card.detailsVersion = card.summary.version;
      return res.details;
    }
    toast(res.error ?? "details unavailable", "warning");
    return null;
  }
}
