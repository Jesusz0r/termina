/**
 * UI panels: toolbar (model/thinking selectors, session controls),
 * status bar, and the clickable "modified files" list.
 */
import type { ModifiedFile, ModelInfo, PiState } from "../../shared/types";

export class Panels {
  private cwdLabel = document.getElementById("cwd-label")!;
  private modelSelect = document.getElementById("model-select") as HTMLSelectElement;
  private thinkingSelect = document.getElementById("thinking-select") as HTMLSelectElement;
  private btnAbort = document.getElementById("btn-abort") as HTMLButtonElement;
  private btnNewSession = document.getElementById("btn-new-session") as HTMLButtonElement;
  private btnSend = document.getElementById("btn-send") as HTMLButtonElement;
  private statusModel = document.getElementById("status-model")!;
  private statusState = document.getElementById("status-state")!;
  private statusCwd = document.getElementById("status-cwd")!;
  private statusSession = document.getElementById("status-session")!;
  private modifiedList = document.getElementById("modified-list")!;
  private modifiedPanel = document.getElementById("modified-panel")!;
  private modifiedCount = document.getElementById("modified-count")!;
  private btnClearModified = document.getElementById("btn-clear-modified") as HTMLButtonElement;

  private onNewSession: () => void = () => {};
  private onAbort: () => void = () => {};
  private onModelChange: (provider: string, id: string) => void = () => {};
  private onThinkingChange: (level: string) => void = () => {};
  private onOpenFile: (path: string) => void = () => {};
  private onClearModified: () => void = () => {};
  private modified: ModifiedFile[] = [];

  bind(handlers: {
    onNewSession: () => void;
    onAbort: () => void;
    onModelChange: (provider: string, id: string) => void;
    onThinkingChange: (level: string) => void;
    onOpenFile: (path: string) => void;
    onClearModified: () => void;
  }): void {
    Object.assign(this, handlers);
    this.btnNewSession.addEventListener("click", () => this.onNewSession());
    this.btnAbort.addEventListener("click", () => this.onAbort());
    // btn-send is wired directly in the renderer entry (sendPrompt); do not
    // duplicate it here or clicks would send twice.
    this.modelSelect.addEventListener("change", () => {
      const [provider, id] = this.modelSelect.value.split("/");
      this.onModelChange(provider, id);
    });
    this.thinkingSelect.addEventListener("change", () => this.onThinkingChange(this.thinkingSelect.value));
    this.btnClearModified.addEventListener("click", (e) => {
      e.stopPropagation(); // don't toggle the panel collapse
      this.onClearModified();
    });
    this.modifiedPanel.querySelector(".panel-header")?.addEventListener("click", () => {
      this.modifiedPanel.classList.toggle("collapsed");
    });
  }

  setState(s: PiState | null): void {
    if (!s) {
      this.statusModel.textContent = "no terminal";
      this.statusState.textContent = "idle";
      this.statusState.classList.remove("busy");
      this.statusCwd.textContent = "";
      this.cwdLabel.textContent = "";
      this.statusSession.textContent = "";
      this.btnAbort.disabled = true;
      this.modelSelect.replaceChildren();
      this.thinkingSelect.replaceChildren();
      return;
    }
    this.statusModel.textContent = s.model ? `${s.model.name}` : "no model";
    this.statusState.textContent = s.isStreaming ? "● agent working" : "idle";
    this.statusState.classList.toggle("busy", s.isStreaming);
    this.statusCwd.textContent = s.cwd ?? "";
    this.cwdLabel.textContent = s.cwd ?? "";
    this.cwdLabel.title = s.cwd ?? "";
    this.statusSession.textContent = s.sessionId ? `session ${s.sessionId.slice(0, 8)}` : "";
    this.btnAbort.disabled = !s.isStreaming;

    // model selector — preserve selection, add models grouped by provider
    const current = s.model ? `${s.model.provider}/${s.model.id}` : "";
    const prev = this.modelSelect.value;
    this.modelSelect.replaceChildren();
    for (const m of s.models) {
      const opt = document.createElement("option");
      opt.value = `${m.provider}/${m.id}`;
      opt.textContent = m.name;
      opt.title = `${m.provider} / ${m.id}`;
      this.modelSelect.appendChild(opt);
    }
    if (this.modelSelect.options.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "no models available";
      this.modelSelect.appendChild(opt);
    }
    this.modelSelect.value = current || prev || "";
    // If the value didn't stick (e.g. the active model isn't in the list),
    // fall back to the first available option instead of a blank select.
    if (!this.modelSelect.value && this.modelSelect.options.length) {
      this.modelSelect.value = this.modelSelect.options[0].value;
    }

    // thinking selector
    const prevLevel = this.thinkingSelect.value;
    this.thinkingSelect.replaceChildren();
    for (const l of s.levels) {
      const opt = document.createElement("option");
      opt.value = l;
      opt.textContent = l;
      this.thinkingSelect.appendChild(opt);
    }
    this.thinkingSelect.value = s.thinkingLevel ?? prevLevel ?? "";
    if (!this.thinkingSelect.value && this.thinkingSelect.options.length) {
      this.thinkingSelect.value = this.thinkingSelect.options[0].value;
    }
  }

  setModified(files: ModifiedFile[]): void {
    this.modified = files;
    this.modifiedCount.textContent = files.length ? `(${files.length})` : "";
    this.modifiedList.replaceChildren();
    for (const f of files) {
      const li = document.createElement("li");
      const badge = document.createElement("span");
      badge.className = `status-badge ${f.status}`;
      badge.textContent = f.status === "created" ? "A" : "M";
      const path = document.createElement("span");
      path.className = "path";
      path.textContent = f.relPath;
      path.title = f.path;
      li.append(badge, path);
      li.addEventListener("click", () => this.onOpenFile(f.path));
      this.modifiedList.appendChild(li);
    }
    this.modifiedPanel.classList.toggle("collapsed", files.length === 0);
  }

  getModified(): ModifiedFile[] {
    return this.modified;
  }
}

export function formatModelList(models: ModelInfo[]): string {
  return models.map((m) => `${m.provider}/${m.id}`).join(", ");
}