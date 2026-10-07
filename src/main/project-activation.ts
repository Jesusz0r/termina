import type { FolderOpenedPayload, ProjectActivateResult } from "../../shared/types";

interface ProjectActivationBindings {
  request(projectId: string): Promise<ProjectActivateResult>;
  prepareRenderer(): Promise<unknown>;
  applyFolder(folder: FolderOpenedPayload): void;
  isCurrent(folder: FolderOpenedPayload): boolean;
  hasProject(projectId: string): boolean;
}

/** Apply the authoritative reply through the same owner as folder pushes.
 * Context selection is synchronous; heavy panel data keeps loading on demand. */
export async function activateProjectContext(
  projectId: string,
  bindings: ProjectActivationBindings,
): Promise<boolean> {
  const result = await bindings.request(projectId);
  if (!result.ok) return false;
  await bindings.prepareRenderer();
  // A close can win while main or the editor chunk is still loading.
  if (!bindings.hasProject(projectId)) return false;
  bindings.applyFolder(result.folder);
  return bindings.isCurrent(result.folder);
}
