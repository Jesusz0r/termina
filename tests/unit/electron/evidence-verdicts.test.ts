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
