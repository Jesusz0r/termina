import type { WorkOverview } from "../../shared/types";
import { pathBasename } from "../../shared/types";
import { reorderPermutation } from "../../shared/tab-order";

/** Persistent navigation only. Main owns projects and the overview owns its factual counts. */
export function createProjectRail(bindings: {
  list: HTMLElement;
  allProjects: HTMLButtonElement;
  onActivate(projectId: string): void;
  onClose(projectId: string): void;
  onAllProjects(opener: HTMLElement): void;
  onReorder(ids: string[]): void;
}): {
  upsert(project: { id: string; cwd: string }): HTMLElement;
  remove(projectId: string): void;
  setActive(projectId: string | null): void;
  setOverview(overview: WorkOverview | null): void;
  orderedIds(): string[];
  setOrder(ids: string[]): void;
  dispose(): void;
} {
  const { list, allProjects } = bindings;
  const rows = new Map<string, {
    row: HTMLElement; select: HTMLButtonElement; name: HTMLElement; path: HTMLElement;
    counts: HTMLElement; working: HTMLElement; attention: HTMLElement; close: HTMLButtonElement;
  }>();
  let facts = new Map<string, WorkOverview["projects"][number]>();
  let activeId: string | null = null;
  let disposed = false;

  function orderedIds(): string[] {
    return [...list.children].flatMap((element) => {
      const id = (element as HTMLElement).dataset.projectId;
      return id && rows.has(id) ? [id] : [];
    });
  }

  function paint(id: string): void {
    const entry = rows.get(id);
    if (!entry) return;
    const project = facts.get(id);
    entry.working.textContent = project ? `${project.working} working` : "Working unknown";
    entry.attention.textContent = project ? `${project.attentionCount} attention` : "Attention unknown";
    entry.attention.classList.toggle("has-attention", !!project?.attentionCount);
    entry.working.classList.toggle("has-work", !!project?.working);
    entry.row.classList.toggle("active", id === activeId);
    if (id === activeId) entry.select.setAttribute("aria-current", "page");
    else entry.select.removeAttribute("aria-current");
  }

  const onClick = (event: MouseEvent): void => {
    if (disposed) return;
    const target = event.target as HTMLElement | null;
    const row = target?.closest<HTMLElement>(".project-tab");
    const id = row?.dataset.projectId;
    if (!id || !rows.has(id)) return;
    if (target?.closest(".tab-close")) bindings.onClose(id);
    else if (target?.closest(".project-select")) bindings.onActivate(id);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (disposed) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(".project-select");
    const id = target?.closest<HTMLElement>(".project-tab")?.dataset.projectId;
    if (!id || !rows.has(id)) return;
    const ids = orderedIds();
    const index = ids.indexOf(id);
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.altKey && delta) {
      const next = index + delta;
      if (next < 0 || next >= ids.length) return;
      const neighbor = rows.get(ids[next]!)!.row;
      const row = rows.get(id)!.row;
      if (delta < 0) list.insertBefore(row, neighbor);
      else list.insertBefore(neighbor, row);
      target.focus({ preventScroll: true });
      bindings.onReorder(orderedIds());
      return;
    }
    const next = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1
      : (index + delta + ids.length) % ids.length;
    rows.get(ids[next]!)?.select.focus();
  };
  const onAll = (): void => { if (!disposed) bindings.onAllProjects(allProjects); };
  list.addEventListener("click", onClick);
  list.addEventListener("keydown", onKey);
  allProjects.addEventListener("click", onAll);

  return {
    upsert: (project) => {
      let entry = rows.get(project.id);
      if (!entry) {
        const row = document.createElement("div");
        row.className = "project-tab";
        row.dataset.projectId = project.id;
        const select = document.createElement("button");
        select.type = "button";
        select.className = "project-select";
        const name = document.createElement("span");
        name.className = "tab-name";
        const path = document.createElement("span");
        path.className = "project-path";
        path.id = `project-path-${project.id}`;
        const counts = document.createElement("span");
        counts.className = "project-counts";
        counts.id = `project-counts-${project.id}`;
        const working = document.createElement("span");
        working.className = "project-working";
        const attention = document.createElement("span");
        attention.className = "project-attention";
        counts.append(working, attention);
        select.setAttribute("aria-describedby", `${path.id} ${counts.id}`);
        select.append(name, path, counts);
        select.title = "Open project · Arrow keys to browse · Alt+Up/Down to reorder";
        const close = document.createElement("button");
        close.type = "button";
        close.className = "tab-close";
        close.textContent = "×";
        close.setAttribute("aria-describedby", path.id);
        row.append(select, close);
        list.appendChild(row);
        entry = { row, select, name, path, counts, working, attention, close };
        rows.set(project.id, entry);
      }
      const name = pathBasename(project.cwd) || project.cwd;
      entry.name.textContent = name;
      entry.name.title = project.cwd;
      entry.path.textContent = project.cwd;
      entry.select.setAttribute("aria-label", `Open project ${name}`);
      entry.close.setAttribute("aria-label", `Close project ${name}`);
      entry.close.title = `Close project ${project.cwd}`;
      paint(project.id);
      return entry.row;
    },
    remove: (id) => {
      const entry = rows.get(id);
      if (!entry) return;
      const focused = entry.row.contains(document.activeElement);
      entry.row.remove();
      rows.delete(id);
      facts.delete(id);
      if (focused) (rows.get(orderedIds()[0] ?? "")?.select ?? allProjects).focus();
    },
    setActive: (id) => { activeId = id; for (const id of rows.keys()) paint(id); },
    setOverview: (overview) => {
      facts = new Map(overview?.projects.map((project) => [project.projectId, project]) ?? []);
      for (const id of rows.keys()) paint(id);
    },
    orderedIds,
    setOrder: (ids) => {
      const order = reorderPermutation(orderedIds(), ids);
      if (!order) return;
      const focused = list.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      for (const id of order) list.appendChild(rows.get(id)!.row);
      focused?.focus({ preventScroll: true });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      list.removeEventListener("click", onClick);
      list.removeEventListener("keydown", onKey);
      allProjects.removeEventListener("click", onAll);
      rows.clear(); facts.clear();
    },
  };
}
