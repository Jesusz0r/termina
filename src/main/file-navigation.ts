import type { ProjectWorkspaceRef } from "../../shared/types";

interface FileNavigationProject {
  id: string;
  cwd: string;
  workspaceId: string;
}

function normalizePath(inputPath: string): string {
  const isAbs = inputPath.startsWith("/");
  const resolved: string[] = [];
  for (const segment of inputPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") resolved.pop();
      else if (!isAbs) resolved.push("..");
    } else {
      resolved.push(segment);
    }
  }
  return (isAbs ? "/" : "") + resolved.join("/");
}

/** Absolute primary-tree links use the longest project root. An explicit
 * candidate owner must never be replaced by a primary workspace. */
export function resolveFileNavigation(
  path: string,
  projects: ReadonlyMap<string, FileNavigationProject>,
  owner: ProjectWorkspaceRef | null,
): { path: string; owner: ProjectWorkspaceRef } | null {
  let cleanPath = path;
  if (cleanPath.startsWith("file://")) {
    cleanPath = cleanPath.slice("file://".length);
    if (cleanPath.startsWith("localhost/")) cleanPath = cleanPath.slice("localhost".length);
  }
  try {
    cleanPath = decodeURIComponent(cleanPath);
  } catch {
    // Keep the raw path when URI decoding fails.
  }
  cleanPath = normalizePath(cleanPath);

  const requestedProject = owner ? projects.get(owner.projectId) : undefined;
  if (owner && !requestedProject) return null;
  const candidate = requestedProject && owner?.workspaceId !== requestedProject.workspaceId;
  if (cleanPath.startsWith("/") && !candidate) {
    let best: FileNavigationProject | undefined;
    for (const project of projects.values()) {
      if (cleanPath === project.cwd || cleanPath.startsWith(project.cwd + "/")) {
        if (!best || project.cwd.length > best.cwd.length) best = project;
      }
    }
    if (best) owner = { projectId: best.id, workspaceId: best.workspaceId };
  }

  const project = owner ? projects.get(owner.projectId) : undefined;
  if (!owner || !project) return null;
  return {
    path: cleanPath.startsWith("/") ? cleanPath : normalizePath(`${project.cwd}/${cleanPath}`),
    owner,
  };
}
