/**
 * Slash-command autocomplete for the prompt input.
 *
 * Fetches the agent's commands (skills, prompt templates, extension commands)
 * from pi's RPC and offers a dropdown when the user types "/". Completing
 * inserts "/name " and the command is executed through the normal prompt path.
 */
import type { PiCommand } from "../../shared/types";

export class CommandMenu {
  private dropdown: HTMLElement;
  private items: PiCommand[] = [];
  private selected = -1;
  private visible = false;
  private loading = false;
  private fetched = false;

  constructor(
    private input: HTMLTextAreaElement,
    private provider: () => Promise<PiCommand[]>,
  ) {
    this.dropdown = document.getElementById("command-menu") as HTMLElement;
    this.dropdown.addEventListener("mousedown", (e) => e.preventDefault()); // keep input focus
  }

  /** Re-evaluate suggestions after input changes. */
  async update(text: string): Promise<void> {
    const isCommand = text.startsWith("/") && !text.includes(" ") && text.length >= 1;
    if (!isCommand) {
      this.close();
      return;
    }
    if (!this.fetched && !this.loading) {
      this.loading = true;
      this.renderLoading();
      try {
        const commands = await this.provider();
        this.fetched = true;
        this.items = commands ?? [];
        this.loading = false;
      } catch (err) {
        // Don't cache failures: show an error and retry on the next keystroke.
        this.loading = false;
        this.fetched = false;
        this.renderError((err as Error).message);
        return;
      }
      // The user may have typed more while we fetched; re-evaluate.
      await this.update(this.input.value);
      return;
    }
    const q = text.slice(1).toLowerCase();
    const matches = this.items.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 12);
    this.selected = matches.length ? 0 : -1;
    this.render(matches);
  }

  /** Returns true when the key was consumed by the menu. */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.visible) return false;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.move(1);
        return true;
      case "ArrowUp":
        e.preventDefault();
        this.move(-1);
        return true;
      case "Tab":
        e.preventDefault();
        this.complete();
        return true;
      case "Enter":
        // Complete only partial matches; an exact match sends the command.
        if (!e.shiftKey && this.selected >= 0) {
          const el = this.dropdown.querySelectorAll(".cmd-item")[this.selected] as HTMLElement | undefined;
          const name = el?.dataset.name;
          if (name && this.input.value !== `/${name}`) {
            e.preventDefault();
            this.complete();
            return true;
          }
        }
        return false;
      case "Escape":
        this.close();
        return true;
      default:
        return false;
    }
  }

  close(): void {
    this.visible = false;
    this.dropdown.replaceChildren();
    this.dropdown.style.display = "none";
  }

  /** Forget the cache (e.g. when switching panes). */
  reset(): void {
    this.fetched = false;
    this.items = [];
    this.close();
  }

  private move(dir: number): void {
    const n = this.dropdown.querySelectorAll(".cmd-item").length;
    if (!n) return;
    this.selected = (this.selected + dir + n) % n;
    this.highlight();
    const el = this.dropdown.querySelectorAll(".cmd-item")[this.selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }

  private highlight(): void {
    this.dropdown.querySelectorAll(".cmd-item").forEach((el, i) => {
      el.classList.toggle("selected", i === this.selected);
    });
  }

  private complete(): void {
    const items = [...this.dropdown.querySelectorAll(".cmd-item")];
    const el = items[this.selected] as HTMLElement | undefined;
    if (!el) return;
    const name = el.dataset.name ?? "";
    this.input.value = `/${name} `;
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    this.close();
    this.input.focus();
  }

  private renderLoading(): void {
    this.visible = true;
    this.dropdown.style.display = "block";
    this.dropdown.replaceChildren();
    const row = document.createElement("div");
    row.className = "cmd-item cmd-loading";
    row.textContent = "… loading commands";
    this.dropdown.appendChild(row);
  }

  private renderError(message: string): void {
    this.visible = true;
    this.dropdown.style.display = "block";
    this.dropdown.replaceChildren();
    const row = document.createElement("div");
    row.className = "cmd-item cmd-loading";
    row.textContent = `✗ couldn't load commands (${message}) — keep typing to retry`;
    this.dropdown.appendChild(row);
  }

  private render(matches: PiCommand[]): void {
    this.dropdown.replaceChildren();
    if (matches.length === 0) {
      this.visible = false;
      this.dropdown.style.display = "none";
      return;
    }
    this.visible = true;
    this.dropdown.style.display = "block";
    for (const cmd of matches) {
      const row = document.createElement("div");
      row.className = "cmd-item";
      row.dataset.name = cmd.name;
      if (this.selected === this.dropdown.children.length) row.classList.add("selected");
      const name = document.createElement("span");
      name.className = "cmd-name";
      name.textContent = `/${cmd.name}`;
      const desc = document.createElement("span");
      desc.className = "cmd-desc";
      desc.textContent = cmd.description;
      const src = document.createElement("span");
      src.className = `cmd-source ${cmd.source}`;
      src.textContent = cmd.source;
      row.append(name, desc, src);
      row.addEventListener("mousemove", () => {
        this.selected = [...row.parentElement!.children].indexOf(row);
        this.highlight();
      });
      row.addEventListener("click", () => {
        this.selected = [...row.parentElement!.children].indexOf(row);
        this.complete();
      });
      this.dropdown.appendChild(row);
    }
    this.highlight();
  }
}