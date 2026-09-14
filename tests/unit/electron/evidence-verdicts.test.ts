import { describe, it, expect } from "vitest";
import { rankProfiles } from "../../../electron/evidence.ts";
import type { EvidenceRecord } from "../../../shared/types.ts";

function record(kind: EvidenceRecord["kind"], status: EvidenceRecord["status"], reason: string | null = null): EvidenceRecord {
  return { kind, stateId: "s", baseStateId: "b", status, result: {}, reason };
}

const verifyPass = (): EvidenceRecord => record("verify", "pass");

function preserveApi(aApi: EvidenceRecord | null, bApi: EvidenceRecord | null): { winner: string; reason: string } {
  const summary = {
    A: [verifyPass(), ...(aApi ? [aApi] : [])],
    B: [verifyPass(), ...(bApi ? [bApi] : [])],
  };
  const verdict = rankProfiles(summary, { A: null, B: null }).find((v) => v.profile === "preserve-api")!;
  return { winner: verdict.winner, reason: verdict.reason };
}

describe("preserve-api verdict (issue #188)", () => {
  it("ties when both candidates fail the API gate", () => {
    const { winner, reason } = preserveApi(
      record("api", "fail", "measured signatures changed: a.d.ts"),
      record("api", "fail", "measured signatures changed: b.d.ts"),
    );
    expect(winner).toBe("tie");
    expect(reason).toContain("both fail the API gate");
    expect(reason).toContain("a.d.ts");
    expect(reason).toContain("b.d.ts");
  });

  it("crowns the passing side on a one-sided failure", () => {
    expect(preserveApi(record("api", "pass"), record("api", "fail", "measured signatures changed: b.d.ts")).winner).toBe("A");
    expect(preserveApi(record("api", "fail", "measured signatures changed: a.d.ts"), record("api", "pass")).winner).toBe("B");
  });

  it("ties when both sides preserve the API", () => {
    const { winner } = preserveApi(record("api", "pass"), record("api", "pass"));
    expect(winner).toBe("tie");
  });

  it("is unavailable when a side is unmeasured", () => {
    expect(preserveApi(record("api", "pass"), null).winner).toBe("unavailable");
    expect(preserveApi(null, null).winner).toBe("unavailable");
    expect(preserveApi(record("api", "pass"), record("api", "unavailable", "no public root")).winner).toBe("unavailable");
  });
});

function benchmarkRecord(median: number, p25: number, p75: number): EvidenceRecord {
  return {
    kind: "benchmark",
    stateId: "s",
    baseStateId: "b",
    status: "pass",
    result: { unit: "ms", direction: "lower", samples: [median], median, p25, p75 },
    reason: null,
  };
}

function performanceFirst(a: EvidenceRecord, b: EvidenceRecord, threshold = 0.05): { winner: string; reason: string } {
  const summary = { A: [verifyPass(), a], B: [verifyPass(), b] };
  const verdict = rankProfiles(summary, { A: null, B: null }, threshold).find((v) => v.profile === "performance-first")!;
  return { winner: verdict.winner, reason: verdict.reason };
}

describe("performance-first variability (issue #193)", () => {
  it("bounds absolute spread for negative medians", () => {
    const { winner, reason } = performanceFirst(
      benchmarkRecord(-100, -130, -70),
      benchmarkRecord(-100, -130, -70),
    );
    expect(winner).toBe("unavailable");
    expect(reason).toContain("variability exceeds");
  });

  it("treats a zero median without spread as a tie, not NaN", () => {
    const { winner, reason } = performanceFirst(
      benchmarkRecord(0, 0, 0),
      benchmarkRecord(0, 0, 0),
    );
    expect(winner).toBe("tie");
    expect(reason).not.toContain("NaN");
  });

  it("falls back to the default threshold when it is NaN", () => {
    const close = { A: benchmarkRecord(100, 99, 101), B: benchmarkRecord(102, 101, 103) };
    expect(performanceFirst(close.A, close.B, NaN).winner).toBe("tie");
    expect(performanceFirst(close.A, close.B, Number.NaN).reason).toContain("5%");
    const far = { A: benchmarkRecord(100, 99, 101), B: benchmarkRecord(200, 199, 201) };
    expect(performanceFirst(far.A, far.B, NaN).winner).toBe("A");
  });
});
