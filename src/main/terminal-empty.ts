type CreateResult = { ok: boolean; error?: string };

/** Display and explicit actions only; the parent owns when this state is visible. */
export function createTerminalEmpty(bindings: {
  element: HTMLElement;
  onCreateAgent(): Promise<CreateResult>;
  onOpenShell(): Promise<CreateResult>;
}): { sync(visible: boolean): void; dispose(): void } {
  const { element } = bindings;
  const agent = element.querySelector<HTMLButtonElement>("#btn-empty-create-agent")!;
  const shell = element.querySelector<HTMLButtonElement>("#btn-empty-open-shell")!;
  const status = element.querySelector<HTMLElement>("#terminal-empty-status")!;
  let pending = false;
  let disposed = false;

  async function run(action: () => Promise<CreateResult>, busy: string): Promise<void> {
    if (disposed || pending || element.hidden) return;
    pending = true;
    agent.disabled = shell.disabled = true;
    element.setAttribute("aria-busy", "true");
    status.textContent = busy;
    try {
      const result = await action();
      if (!disposed) status.textContent = result.ok ? "" : result.error || "Terminal was not created. Try again.";
    } catch (error) {
      if (!disposed) status.textContent = error instanceof Error ? error.message : "Terminal was not created. Try again.";
    } finally {
      pending = false;
      if (!disposed) {
        agent.disabled = shell.disabled = false;
        element.setAttribute("aria-busy", "false");
      }
    }
  }
  const onAgent = (): void => { void run(bindings.onCreateAgent, "Creating agent…"); };
  const onShell = (): void => { void run(bindings.onOpenShell, "Opening shell…"); };
  agent.addEventListener("click", onAgent);
  shell.addEventListener("click", onShell);
  return {
    sync: (visible) => { if (!disposed) element.hidden = !visible; },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      agent.removeEventListener("click", onAgent);
      shell.removeEventListener("click", onShell);
    },
  };
}
