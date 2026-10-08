import type { PlanTask, PlanTaskCreateRequest, ReviewTarget, TerminaBridge, WorkOverview } from "../../shared/types";

type Destination = { projectRoot: string; owner: ReviewTarget };
const destinationKey = (destination: Destination): string => JSON.stringify(destination);

/** Inline draft; main remains the sole admission and Plan Board owner. */
export function createNewTaskComposer(options: {
  element: HTMLElement;
  createPlanTask: TerminaBridge["createPlanTask"];
  onCreated: (request: PlanTaskCreateRequest, task: PlanTask) => void;
}): {
  open(projectId?: string, opener?: HTMLElement): void;
  close(restoreFocus?: boolean): void;
  setOverview(overview: WorkOverview | null): void;
  dispose(): void;
} {
  const form = document.createElement("form");
  form.className = "overview-task-composer";
  form.hidden = true;
  const heading = document.createElement("h3");
  heading.textContent = "New task";
  function field<T extends HTMLInputElement | HTMLSelectElement>(labelText: string, control: T): T {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = labelText;
    label.append(caption, control);
    form.append(label);
    return control;
  }
  form.append(heading);
  const project = field("Project", document.createElement("select"));
  project.className = "overview-task-project";
  const board = field("Plan Board", document.createElement("select"));
  board.className = "overview-task-board";
  const root = document.createElement("p");
  root.className = "overview-task-destination";
  form.append(root);
  const outcome = field("Outcome", document.createElement("input"));
  outcome.className = "overview-task-outcome";
  outcome.type = "text";
  outcome.maxLength = 500;
  outcome.required = true;
  const actions = document.createElement("div");
  actions.className = "overview-task-actions";
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "Create task";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  actions.append(submit, cancel);
  const status = document.createElement("p");
  status.className = "overview-task-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  form.append(actions, status);
  options.element.append(form);

  let overview: WorkOverview | null = null;
  let selectedProject: { id: string; root: string } | null = null;
  let destination: Destination | null = null;
  let stale = false;
  let pending = false;
  let disposed = false;
  let epoch = 0;
  let opener: HTMLElement | undefined;
  let requestError = "";

  function destinations() {
    return (overview?.projects ?? []).flatMap((item) => item.terminals
      .filter((terminal) => terminal.type === "agent" && terminal.workArea !== null)
      .map((terminal) => ({
        destination: { projectRoot: item.root, owner: {
          projectId: item.projectId, terminalId: terminal.terminalId, generation: terminal.generation,
          workspaceId: terminal.workArea!.workspaceId, root: terminal.workArea!.root,
        } } satisfies Destination,
        error: terminal.planCreationError,
      })));
  }
  function current() {
    if (!destination || stale) return undefined;
    const key = destinationKey(destination);
    return destinations().find((item) => destinationKey(item.destination) === key);
  }
  function admissionError(): string {
    if (stale) return "Destination unavailable or changed. Choose a Project or Plan Board again.";
    if (!overview) return "Project overview unavailable. Wait for a current overview.";
    if (!selectedProject) return "Choose a destination project.";
    if (!destination) return destinations().some((item) => item.destination.owner.projectId === selectedProject!.id)
      ? "Choose an existing agent Plan Board." : "No existing agent Plan Board is available in this project.";
    return current()?.error ?? (current() ? "" : "Destination unavailable. Choose a Plan Board again.");
  }
  function updateStatus() {
    const error = admissionError();
    submit.disabled = pending || !!error || !outcome.value.trim();
    project.disabled = pending;
    board.disabled = pending;
    outcome.disabled = pending;
    cancel.disabled = pending;
    status.textContent = pending ? "Creating task… The request is queued; it does not start execution." : requestError || error || "Creates a pending Plan Board task without running it. Later, Start task uses a separate sandboxed candidate; nothing is automatically applied, staged or committed.";
  }
  function addOption(select: HTMLSelectElement, value: string, text: string, disabled = false) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    option.disabled = disabled;
    select.append(option);
  }
  function refresh() {
    if (destination && !destinations().some((item) => destinationKey(item.destination) === destinationKey(destination!))) stale = true;
    if (selectedProject && !overview?.projects.some((item) => item.projectId === selectedProject!.id && item.root === selectedProject!.root)) stale = true;
    project.replaceChildren();
    addOption(project, "", "Choose a project");
    for (const item of overview?.projects ?? []) addOption(project, item.projectId, `${item.name} — ${item.root}`);
    if (selectedProject && !overview?.projects.some((item) => item.projectId === selectedProject!.id)) {
      addOption(project, selectedProject.id, `Unavailable — ${selectedProject.root}`, true);
    }
    project.value = selectedProject?.id ?? "";
    board.replaceChildren();
    addOption(board, "", "Choose an existing agent Plan Board");
    const choices = destinations().filter((item) => item.destination.owner.projectId === selectedProject?.id);
    for (const item of choices) {
      const owner = item.destination.owner;
      addOption(board, destinationKey(item.destination), `${owner.terminalId} · ${owner.root}${item.error ? ` — ${item.error}` : ""}`, item.error !== null);
    }
    if (destination && !choices.some((item) => destinationKey(item.destination) === destinationKey(destination!))) {
      addOption(board, destinationKey(destination), `${destination.owner.terminalId} — unavailable or changed`, true);
    }
    board.value = destination ? destinationKey(destination) : "";
    root.textContent = selectedProject ? `Project: ${selectedProject.root}${destination ? `\nPlan Board: ${destination.owner.root}` : ""}` : "Choose a destination project.";
    updateStatus();
  }
  function chooseProject(id: string) {
    const item = overview?.projects.find((candidate) => candidate.projectId === id);
    selectedProject = item ? { id, root: item.root } : null;
    const choices = destinations().filter((choice) => choice.destination.owner.projectId === id);
    destination = (choices.find((choice) => choice.error === null) ?? choices[0])?.destination ?? null;
    stale = false;
    requestError = "";
    refresh();
  }
  function close(restoreFocus = false) {
    ++epoch;
    form.hidden = true;
    pending = false;
    if (restoreFocus && opener?.isConnected && !opener.hidden) opener.focus();
  }
  const onProjectChange = () => { if (!pending) chooseProject(project.value); };
  const onBoardChange = () => {
    if (pending) return;
    const choice = destinations().find((item) => destinationKey(item.destination) === board.value && item.destination.owner.projectId === selectedProject?.id);
    if (!choice || choice.error !== null) return;
    destination = choice.destination;
    selectedProject = { id: destination.owner.projectId, root: destination.projectRoot };
    stale = false;
    requestError = "";
    refresh();
  };
  const onInput = () => { requestError = ""; updateStatus(); };
  const onCancel = () => { if (!pending) close(true); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || form.hidden || !form.contains(event.target as Node)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!pending) close(true);
  };
  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (disposed || form.hidden || pending) return;
    refresh();
    const text = outcome.value.trim();
    if (admissionError() || !destination || !text || text.length > 500 || /[\r\n]/.test(text)) return;
    const request: PlanTaskCreateRequest = { owner: { ...destination.owner }, projectRoot: destination.projectRoot, text };
    const submissionEpoch = epoch;
    pending = true;
    requestError = "";
    updateStatus();
    try {
      const result = await options.createPlanTask(request);
      if (disposed || submissionEpoch !== epoch || form.hidden) return;
      pending = false;
      if (result.ok) {
        const active = document.activeElement;
        close(active === document.body || (active !== null && form.contains(active)));
        options.onCreated(request, result.task);
      } else {
        requestError = result.error;
        updateStatus();
      }
    } catch (error) {
      if (disposed || submissionEpoch !== epoch || form.hidden) return;
      pending = false;
      requestError = error instanceof Error ? error.message : "Task creation failed.";
      updateStatus();
    }
  };
  project.addEventListener("change", onProjectChange);
  board.addEventListener("change", onBoardChange);
  outcome.addEventListener("input", onInput);
  cancel.addEventListener("click", onCancel);
  form.addEventListener("keydown", onKeyDown);
  form.addEventListener("submit", onSubmit);
  return {
    open(projectId, nextOpener) {
      if (disposed) return;
      ++epoch;
      pending = false;
      opener = nextOpener;
      outcome.value = "";
      form.hidden = false;
      chooseProject(overview?.projects.find((item) => item.projectId === projectId)?.projectId ?? overview?.projects[0]?.projectId ?? "");
      outcome.focus();
    },
    close,
    setOverview(value) { overview = value; if (!disposed && !form.hidden) refresh(); },
    dispose() {
      disposed = true;
      close();
      project.removeEventListener("change", onProjectChange);
      board.removeEventListener("change", onBoardChange);
      outcome.removeEventListener("input", onInput);
      cancel.removeEventListener("click", onCancel);
      form.removeEventListener("keydown", onKeyDown);
      form.removeEventListener("submit", onSubmit);
      form.remove();
    },
  };
}
