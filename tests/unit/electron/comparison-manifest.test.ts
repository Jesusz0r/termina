import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseComparisonManifest } from "../../../electron/worldlines/comparison-manifest.ts";

const path = join(tmpdir(), "termina-manifest-candidate");
const candidate = { pid: null, lstart: null, paths: [path] };
const manifest = {
  id: "cmp-1", sourceRunId: "run-1", createdAt: 1, status: "creating", expectedCandidates: 1,
  candidates: { A: candidate }, uncertainSessionArtifacts: [],
};

describe("comparison manifest parser", () => {
  it("returns typed candidates and artifacts without sharing raw nested objects", () => {
    const artifact = { path, error: "fixture failure" };
    const input = { ...manifest, status: "uncertain", uncertainSessionArtifacts: [artifact] };
    const parsed = parseComparisonManifest(input);
    expect(parsed).toEqual(input);
    expect(parsed?.candidates.A).not.toBe(candidate);
    expect(parsed?.candidates.A?.paths).not.toBe(candidate.paths);
    expect(parsed?.uncertainSessionArtifacts[0]).not.toBe(artifact);
  });

  it.each([null, [], "candidate", 1].map((value) => ({ value })))("rejects non-object candidate $value", ({ value }) => {
    expect(parseComparisonManifest({ ...manifest, candidates: { A: value } })).toBeNull();
  });

  it.each([null, [], "artifact", 1].map((value) => ({ value })))("rejects non-object artifact $value", ({ value }) => {
    expect(parseComparisonManifest({ ...manifest, uncertainSessionArtifacts: [value] })).toBeNull();
  });

  it("preserves the creating, complete and uncertain status rules", () => {
    expect(parseComparisonManifest({ ...manifest, candidates: {} })).not.toBeNull();
    expect(parseComparisonManifest({ ...manifest, status: "complete" })).not.toBeNull();
    expect(parseComparisonManifest({ ...manifest, status: "complete", candidates: {} })).toBeNull();
    expect(parseComparisonManifest({ ...manifest, status: "uncertain" })).toBeNull();
    expect(parseComparisonManifest({ ...manifest, status: "complete", uncertainSessionArtifacts: [{ path, error: "failure" }] })).toBeNull();
    expect(parseComparisonManifest({ ...manifest, candidates: { A: candidate, B: candidate } })).toBeNull();
  });

  it("requires a complete durable origin for an independent session", () => {
    expect(parseComparisonManifest({ ...manifest, sourceRunId: null })).toBeNull();
    const session = { primaryRoot: path, sourceGitDir: join(path, ".git"), baseStateId: "base", model: null, thinkingLevel: null };
    expect(parseComparisonManifest({ ...manifest, sourceRunId: null, session })?.session).toEqual(session);
    expect(parseComparisonManifest({ ...manifest, sourceRunId: null, session: { ...session, primaryRoot: "relative" } })).toBeNull();
    expect(parseComparisonManifest({ ...manifest, sourceRunId: null, session, expectedCandidates: 2 })).toBeNull();
  });

  it("rejects malformed candidate and artifact fields before use", () => {
    for (const fields of [{ pid: -1 }, { pid: 1.5 }, { pid: undefined }, { lstart: undefined }, { paths: [] }, { paths: [42] }, { paths: ["relative"] }]) {
      expect(parseComparisonManifest({ ...manifest, candidates: { A: { ...candidate, ...fields } } })).toBeNull();
    }
    expect(parseComparisonManifest({ ...manifest, candidates: [] })).toBeNull();
    expect(parseComparisonManifest({ ...manifest, uncertainSessionArtifacts: [{ path: "relative", error: "failure" }] })).toBeNull();
    expect(parseComparisonManifest({ ...manifest, uncertainSessionArtifacts: [{ path, error: "" }] })).toBeNull();
  });
});
