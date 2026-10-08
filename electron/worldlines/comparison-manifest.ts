/** Comparison manifest parsing and construction. No recovery or filesystem state. */
import { isAbsolute } from "node:path";
import { isRecord } from "../../shared/guards.js";
import type {
  ComparisonManifest,
  ComparisonManifestCandidate,
  ComparisonManifestStatus,
  ComparisonState,
} from "./types.js";

function parseCandidate(value: unknown): ComparisonManifestCandidate | null {
  if (!isRecord(value)) return null;
  const { pid, lstart, paths: rawPaths } = value;
  if (pid !== null && (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0)) return null;
  if (lstart !== null && typeof lstart !== "string") return null;
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) return null;
  const paths: string[] = [];
  for (const path of rawPaths) {
    if (typeof path !== "string" || !isAbsolute(path)) return null;
    paths.push(path);
  }
  return { pid, lstart, paths };
}

function parseArtifact(value: unknown): { path: string; error: string } | null {
  if (!isRecord(value)) return null;
  const { path, error } = value;
  if (typeof path !== "string" || !path || !isAbsolute(path) || typeof error !== "string" || !error) return null;
  return { path, error };
}

/** Parse only a complete manifest shape; null is deliberately fail-closed. */
export function parseComparisonManifest(value: unknown): ComparisonManifest | null {
  if (!isRecord(value)) return null;
  const { id, sourceRunId, createdAt, status, expectedCandidates, candidates: rawCandidates, uncertainSessionArtifacts: rawArtifacts } = value;
  if (typeof id !== "string" || !id || (sourceRunId !== null && (typeof sourceRunId !== "string" || !sourceRunId))) return null;
  let session: ComparisonManifest["session"];
  if (sourceRunId === null) {
    const s = value.session;
    if (!isRecord(s) || typeof s.primaryRoot !== "string" || !isAbsolute(s.primaryRoot) || typeof s.baseStateId !== "string" || !s.baseStateId
      || typeof s.sourceGitDir !== "string" || !isAbsolute(s.sourceGitDir)
      || (s.model !== null && typeof s.model !== "string")
      || (s.thinkingLevel !== null && typeof s.thinkingLevel !== "string")) return null;
    if (s.primaryStateId !== undefined && (typeof s.primaryStateId !== "string" || !s.primaryStateId)) return null;
    if (s.sourceSessionFile !== undefined && (typeof s.sourceSessionFile !== "string" || !isAbsolute(s.sourceSessionFile))) return null;
    session = { ...(typeof s.primaryStateId === "string" ? { primaryStateId: s.primaryStateId } : {}),
      ...(typeof s.sourceSessionFile === "string" ? { sourceSessionFile: s.sourceSessionFile } : {}), primaryRoot: s.primaryRoot, baseStateId: s.baseStateId, sourceGitDir: s.sourceGitDir, model: s.model, thinkingLevel: s.thinkingLevel };
  } else if (value.session !== undefined) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (status !== "creating" && status !== "complete" && status !== "uncertain") return null;
  if (expectedCandidates !== 1 && expectedCandidates !== 2) return null;
  if (!isRecord(rawCandidates) || !Array.isArray(rawArtifacts)) return null;
  const candidates: Record<string, ComparisonManifestCandidate> = {};
  for (const [label, rawCandidate] of Object.entries(rawCandidates)) {
    if (label !== "A" && label !== "B") return null;
    const candidate = parseCandidate(rawCandidate);
    if (candidate === null) return null;
    candidates[label] = candidate;
  }
  const count = Object.keys(candidates).length;
  if (count > expectedCandidates) return null;
  const uncertainSessionArtifacts: ComparisonManifest["uncertainSessionArtifacts"] = [];
  for (const rawArtifact of rawArtifacts) {
    const artifact = parseArtifact(rawArtifact);
    if (artifact === null) return null;
    uncertainSessionArtifacts.push(artifact);
  }
  if (status === "complete" && (count !== expectedCandidates || uncertainSessionArtifacts.length > 0)) return null;
  if (status === "uncertain" && uncertainSessionArtifacts.length === 0) return null;
  if (session && expectedCandidates !== 1) return null;
  return { id, sourceRunId, ...(session ? { session } : {}), createdAt, status, expectedCandidates, candidates, uncertainSessionArtifacts };
}

export function comparisonManifestFor(cmp: ComparisonState, status: ComparisonManifestStatus = "creating"): ComparisonManifest {
  const candidates: Record<string, ComparisonManifestCandidate> = {};
  for (const [label, cand] of cmp.candidates) {
    candidates[label] = { pid: cand.pid, lstart: cand.lstart, paths: [cand.dir, cand.supportDir] };
  }
  return {
    id: cmp.id,
    sourceRunId: cmp.sourceRunId,
    ...(cmp.sourceRunId === null && cmp.baseStateId ? { session: {
      ...(cmp.primaryStateId ? { primaryStateId: cmp.primaryStateId } : {}),
      ...(cmp.sourceSessionFile ? { sourceSessionFile: cmp.sourceSessionFile } : {}), primaryRoot: cmp.primaryRoot, baseStateId: cmp.baseStateId, sourceGitDir: cmp.sourceGitDir, model: cmp.model, thinkingLevel: cmp.thinkingLevel,
    } } : {}),
    createdAt: cmp.createdAt,
    status,
    expectedCandidates: cmp.expectedCandidates,
    candidates,
    uncertainSessionArtifacts: [...cmp.uncertainSessionArtifacts],
  };
}
