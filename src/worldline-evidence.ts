import type { EvidenceRecord, EvidenceSummary, ProfileVerdict } from "../shared/types";

export const PROFILE_LABEL: Record<ProfileVerdict["profile"], string> = {
  "fewer-dependencies": "fewer deps",
  "preserve-api": "api",
  "simpler-implementation": "footprint",
  "performance-first": "perf",
};

export const KIND_LABEL: Record<EvidenceRecord["kind"], string> = {
  verify: "verify",
  dependencies: "deps",
  api: "api",
  footprint: "footprint",
  benchmark: "benchmark",
  trajectory: "trajectory",
};

function captionName(profile: ProfileVerdict["profile"]): string {
  return profile === "fewer-dependencies" ? "deps" : PROFILE_LABEL[profile];
}

export function recordOf(records: EvidenceRecord[] | undefined, kind: EvidenceRecord["kind"]): EvidenceRecord | undefined {
  return records?.find((r) => r.kind === kind);
}

function addedLen(rec: EvidenceRecord | undefined): number | null {
  const added = rec?.result.added;
  return Array.isArray(added) ? added.length : null;
}

function asFinite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatChipNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return s.length > 0 ? s : String(n);
}

function chipUnit(value: unknown): string {
  if (typeof value !== "string") return "";
  const unit = value.trim();
  return unit.length > 0 && unit.length <= 8 ? unit : "";
}

/** Raw A/B magnitudes from measured records. Ranking math stays in reason. */
function chipDelta(profile: ProfileVerdict["profile"], summary: EvidenceSummary): string | null {
  const a = summary.byCandidate.A;
  const b = summary.byCandidate.B;
  if (profile === "fewer-dependencies") {
    const na = addedLen(recordOf(a, "dependencies"));
    const nb = addedLen(recordOf(b, "dependencies"));
    if (na === null || nb === null) return null;
    return `+${na}/+${nb}`;
  }
  if (profile === "simpler-implementation") {
    const fa = recordOf(a, "footprint");
    const fb = recordOf(b, "footprint");
    const aFiles = asFinite(fa?.result.changedFiles);
    const aLines = asFinite(fa?.result.changedLines);
    const bFiles = asFinite(fb?.result.changedFiles);
    const bLines = asFinite(fb?.result.changedLines);
    if (aFiles === null || aLines === null || bFiles === null || bLines === null) return null;
    const aAdd = addedLen(recordOf(a, "dependencies")) ?? 0;
    const bAdd = addedLen(recordOf(b, "dependencies")) ?? 0;
    return `${aAdd}d/${formatChipNum(aFiles)}f/${formatChipNum(aLines)}l vs ${bAdd}d/${formatChipNum(bFiles)}f/${formatChipNum(bLines)}l`;
  }
  if (profile === "performance-first") {
    const ba = recordOf(a, "benchmark");
    const bb = recordOf(b, "benchmark");
    const medA = asFinite(ba?.result.median);
    const medB = asFinite(bb?.result.median);
    if (medA === null || medB === null) return null;
    const unit = chipUnit(ba?.result.unit) || chipUnit(bb?.result.unit);
    return unit
      ? `${formatChipNum(medA)}${unit} vs ${formatChipNum(medB)}${unit}`
      : `${formatChipNum(medA)} vs ${formatChipNum(medB)}`;
  }
  return null;
}

export function chipText(v: ProfileVerdict, summary: EvidenceSummary): string {
  const name = PROFILE_LABEL[v.profile];
  const delta = chipDelta(v.profile, summary);
  if (v.winner === "unavailable") return delta ? `${name}: unavailable ${delta}` : `${name}: unavailable`;
  return delta ? `${name}: ${v.winner} ${delta}` : `${name}: ${v.winner}`;
}

/**
 * One line from ranked profiles. Skip unavailable. Omit when nothing
 * resolved to A or B. Stale pairs keep this line; the stale chip marks
 * the ranking as not current.
 */
export function profileCaption(profiles: ProfileVerdict[] | undefined): string | null {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  const resolved: Array<{ winner: "A" | "B" | "tie"; name: string }> = [];
  for (const v of profiles) {
    if (v.winner !== "A" && v.winner !== "B" && v.winner !== "tie") continue;
    const name = captionName(v.profile);
    if (!name) continue;
    resolved.push({ winner: v.winner, name });
  }
  if (!resolved.some((v) => v.winner === "A" || v.winner === "B")) return null;
  const parts: string[] = [];
  for (const winner of ["A", "B", "tie"] as const) {
    const names = resolved.filter((v) => v.winner === winner).map((v) => v.name);
    if (names.length === 0) continue;
    parts.push(winner === "tie" ? `${names.join(" ")} tie` : `${names.join(" ")} → ${winner}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** This candidate's measured detail, plus the other side when both exist. */
export function evidenceLineDetail(rec: EvidenceRecord, other: EvidenceRecord | undefined, otherLabel: "A" | "B"): string {
  if (rec.kind === "verify") {
    const cmd = String(rec.result.command ?? "");
    const passCount = asFinite(rec.result.passCount);
    const runs = asFinite(rec.result.runs);
    if (passCount !== null && runs !== null && runs > 1) {
      return cmd ? `${cmd} · ${formatChipNum(passCount)}/${formatChipNum(runs)}` : `${formatChipNum(passCount)}/${formatChipNum(runs)}`;
    }
    return cmd;
  }
  if (rec.kind === "dependencies") {
    const n = addedLen(rec);
    const m = addedLen(other);
    if (n === null) return "";
    return m === null ? `+${n}` : `+${n} · ${otherLabel} +${m}`;
  }
  if (rec.kind === "footprint") {
    const files = rec.result.changedFiles ?? "?";
    const lines = rec.result.changedLines ?? "?";
    const mine = `${files} files · ${lines} lines`;
    const oFiles = asFinite(other?.result.changedFiles);
    const oLines = asFinite(other?.result.changedLines);
    if (oFiles === null || oLines === null) return mine;
    return `${mine} · ${otherLabel} ${oFiles}f/${oLines}l`;
  }
  if (rec.kind === "benchmark") {
    const med = asFinite(rec.result.median);
    const unit = chipUnit(rec.result.unit);
    const mine = med === null ? String(rec.result.median ?? "?") : unit ? `${formatChipNum(med)} ${unit}` : formatChipNum(med);
    const oMed = asFinite(other?.result.median);
    if (oMed === null) return mine;
    const oUnit = chipUnit(other?.result.unit) || unit;
    return oUnit ? `${mine} · ${otherLabel} ${formatChipNum(oMed)}${oUnit}` : `${mine} · ${otherLabel} ${formatChipNum(oMed)}`;
  }
  if (rec.kind === "trajectory") {
    const errors = asFinite(rec.result.fileToolErrors);
    if (errors === null) return "";
    const lastErr = asFinite(rec.result.lastErrorCount);
    return lastErr !== null && lastErr > 0 ? `${formatChipNum(errors)} file-tool errors · ${formatChipNum(lastErr)} last-path errors` : `${formatChipNum(errors)} file-tool errors`;
  }
  if (rec.status === "fail") return (rec.result.changed as string[] | undefined)?.join(",") ?? "";
  return "";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
